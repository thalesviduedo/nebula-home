"""
Supervisão da ponte de vídeo (processo Go + RTSP + leitores MJPEG).

Este módulo é a resposta direta à falha recorrente relatada:

    `InvalidDataError` / "stream seco", processo Go vivo, caminho RTSP
    registrado, zero bytes, para sempre.

Por que isso acontecia (três defeitos que se somavam):

  1. **Registro ≠ mídia.** O `tuya-ipc-terminal` criava o stream assim que o
     leitor RTSP aparecia, antes do WebRTC/MQTT entregarem qualquer coisa. O
     backend tratava "stream existe" como "câmera funciona".
  2. **Só reiniciava com token novo.** `_rtsp_token_changed` comparava a
     sessão do bundle com a do processo. Sessão que *expira na nuvem* sem
     trocar de token = processo zumbi eterno.
  3. **Sem lock.** Duas requisições simultâneas (uma aba com MJPEG + o poll de
     `/api/cam.status`) podiam cada uma decidir "não está no ar" e cada uma
     spawnar um `serve`. O perdedor do `bind()` morria, o vencedor deixava o
     `_pump` do processo morto escrevendo no registry — fontes cameras de uma
     sessão que já não existia.

O que este módulo faz:

  * **watchdog** com dois orçamentos (conectar / silêncio de mídia), usando o
    endpoint `/media` do Go como fonte primária e o estado dos leitores PyAV
    como fonte independente;
  * **três níveis de recuperação**, do mais barato ao mais pesado:
      1. derrubar só a câmera (`POST /restart` no Go) — o próximo leitor
         reconstrói o stream com MQTT e oferta novos;
      2. reiniciar o processo Go inteiro;
      3. parar tudo e pedir re-login, quando a sessão é que está morta;
  * **rate limit** nos restarts, para uma sessão inválida não virar loop de
    crash;
  * **lock único** em start/stop/sync, e *geração* por processo, para o leitor
    de log de um processo morto nunca mais mexer no estado do novo.
"""

from __future__ import annotations

import io
import json
import os
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.request

# --- política (tudo sobrescrevível por ambiente, para teste) -----------------
TICK = float(os.environ.get("NEBULA_CAM_TICK", "3"))
CONNECT_TIMEOUT = float(os.environ.get("NEBULA_CAM_CONNECT_TIMEOUT", "35"))
STALL_TIMEOUT = float(os.environ.get("NEBULA_CAM_STALL_TIMEOUT", "12"))
# Tempo que uma câmera pode ficar sem mídia antes de contarmos como morta.
CAMERA_DRY_DEADLINE = float(os.environ.get("NEBULA_CAM_DRY", "14"))
# Depois de derrubar só a câmera, quanto tempo esperamos antes de matar o
# processo inteiro.
CAMERA_ESCALATE = float(os.environ.get("NEBULA_CAM_ESCALATE", "50"))
# Teto de reinícios de processo numa janela — evita loop de crash.
RESTART_WINDOW = float(os.environ.get("NEBULA_CAM_RESTART_WINDOW", "300"))
RESTART_BUDGET = int(os.environ.get("NEBULA_CAM_RESTART_BUDGET", "4"))
BOOT_TIMEOUT = float(os.environ.get("NEBULA_CAM_BOOT_TIMEOUT", "40"))

HEALTH_TIMEOUT = float(os.environ.get("NEBULA_CAM_HEALTH_TIMEOUT", "2.5"))


def _now() -> float:
    return time.monotonic()


_HINTS: list[str] = []


def _log_hint(msg: str) -> None:
    """
    Aviso de fora do bridge (ex.: falha ao buscar o MQTT URL). Vai para o
    mesmo log que a UI mostra, para o diagnóstico não ficar partido.
    """
    _HINTS.append(f"{time.strftime('%H:%M:%S')} {msg[:160]}")
    del _HINTS[:-20]


def drain_hints() -> list[str]:
    out = list(_HINTS)
    return out


class CamBridge:
    """Dono do processo `tuya-ipc-terminal serve` e do seu estado."""

    def __init__(self, binary: str, rtsp_base: str, port: int, manager,
                 cloud_of, mqtt_url_of, on_restart=None):
        self.binary = binary
        self.rtsp_base = rtsp_base.rstrip("/")
        self.port = port
        self.health_port = port + 1
        self.manager = manager          # tuya_rtsp.MANAGER
        self._cloud_of = cloud_of       # callable(bundle) -> token
        self._mqtt_of = mqtt_url_of     # callable(bundle) -> str
        self._on_restart = on_restart

        self.lock = threading.RLock()
        # serializa start/stop por inteiro (ver start())
        self.boot_lock = threading.RLock()
        self.proc: subprocess.Popen | None = None
        self.started_at = 0.0
        self.token = ""
        self.generation = 0
        self.log: list[str] = []
        self.cameras: dict[str, dict] = {}
        self.media: dict[str, dict] = {}
        self.health: dict = {}
        self.health_fails = 0
        self.health_reachable = False

        # erro acionável para a UI
        self.error = ""
        self.error_kind = ""
        self.action = ""          # "", "relogin", "retry", "none"
        self.fatal_reason = ""    # NEBULA_FATAL do Go

        # watchdog
        self.dry_since: dict[str, float] = {}
        self.cam_state: dict[str, dict] = {}
        self.restarts = 0            # toda ação de recuperação
        self.process_restarts = 0   # só as que derrubam o processo
        self.restart_log: list[str] = []
        self.restart_times: list[float] = []
        self.last_action: str = ""
        self.last_action_at = 0.0

        self._stop_watchdog = threading.Event()
        self._watchdog: threading.Thread | None = None
        # bundle do último request que wanted the bridge up; o watchdog usa
        # para reconstruir quando precisa reiniciar.
        self._last_bundle: dict = {}

    # -- log --------------------------------------------------------------
    def _logline(self, line: str) -> None:
        self.log.append(line[-200:])
        del self.log[:-40]

    def _note_action(self, action: str) -> None:
        self.last_action = action
        self.last_action_at = time.time()
        self._logline(f"watchdog: {action}")

    # -- sessão -----------------------------------------------------------
    def _session_problem(self, bundle: dict) -> tuple[str, str]:
        """
        A sessão do bundle não consegue ancorar vídeo. Devolve (action, mensagem)
        ou ("", "") se está tudo em ordem.

        Regra: sem accessToken não há ecode, sem ecode o `user.info.get` não
        devolve `mobileMqttsUrl`, e sem broker o Go não tem por onde puxar
        mídia — ele abria o stream e entregava zero bytes. Não subimos nada.
        """
        cloud = bundle.get("cloud") or {}
        if not cloud:
            return "", ""
        if not cloud.get("cookies") or not cloud.get("host"):
            return "", ""
        if not str(cloud.get("accessToken") or "").strip():
            return ("relogin",
                    "sessão parcial: login por QR não traz accessToken; "
                    "faça login com e-mail e senha para a câmera funcionar")
        if not str(cloud.get("uid") or "").strip():
            return ("relogin",
                    "sessão sem uid; refaça o login com e-mail e senha")
        if not str(cloud.get("mobileMqttsUrl") or "").strip():
            url = ""
            try:
                url = self._mqtt_of(cloud) or ""
            except Exception:
                url = ""
            if not url:
                return ("relogin",
                        "não foi possível obter o broker MQTT da conta "
                        "(mobileMqttsUrl vazio): refaça o login com e-mail e senha")
        return "", ""

    # -- processo ---------------------------------------------------------
    def stop(self, reason: str = "") -> None:
        with self.boot_lock:
            with self.lock:
                proc, self.proc = self.proc, None
                self.token = ""
                self.media = {}
                self.health = {}
                self.health_reachable = False
                self.cameras = {}   # <-- fontes de uma sessão morta não podem sobreviver
                self.dry_since = {}
                self.cam_state = {}
                self.generation += 1
            if proc is not None and proc.poll() is None:
                self._terminate(proc)
            if reason:
                self._logline(f"ponte encerrada ({reason})")

    @staticmethod
    def _terminate(proc: subprocess.Popen) -> None:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
                proc.wait(timeout=3)
            except Exception:
                pass
        # fecha o pipe para o _pump sair
        try:
            if proc.stdout:
                proc.stdout.close()
        except Exception:
            pass

    def alive(self) -> bool:
        with self.lock:
            return self.proc is not None and self.proc.poll() is None

    def start(self, bundle: dict, force: bool = False) -> dict:
        """
        Sobe (ou reaproveita) o processo. Idempotente e serializado: duas
        requisições simultâneas nunca criam dois processos.

        `force=True` ignora o reaproveitamento por token — é o que o watchdog
        usa quando a ponte está viva mas morta por dentro. Sem ele, o
        reinício era silenciosamente um no-op (mesmo token => "already").
        """
        # boot_lock cobre o INTEIRO ciclo (checar -> derrubar -> esperar a
        # porta -> Popen). Com o lock só nas partes, duas requisições
        # simultâneas (o MJPEG de uma aba e o poll de /api/cam.status de
        # outra) faziam as duas passar por "não está no ar": uma vencia o
        # bind, a outra morria e — pior — sobrescrevia self.proc, deixando a
        # primeira órfã segurando 8554. Era o "processo zumbi" mais difícil
        # de matar, porque a UI mostrava uma ponte que só existia no limbo.
        with self.boot_lock:
            return self._start_locked(bundle, force)

    def _start_locked(self, bundle: dict, force: bool) -> dict:
        token = ""
        try:
            token = self._cloud_of(bundle) or ""
        except Exception as exc:
            return {"ok": False, "reason": str(exc)[:160]}

        if not token:
            self.stop("sem sessão no bundle")
            return {"ok": False, "reason": "sem sessão no bundle"}

        self._last_bundle = bundle

        with self.lock:
            old = self.proc
            if (not force and old is not None and old.poll() is None
                    and self.token == token):
                return {"ok": True, "already": True}
            self.proc = None
            self.token = ""
        # Derruba o processo anterior FORA do lock: terminate() espera o
        # processo e segurar o lock aqui serializava toda a API.
        if old is not None:
            self._terminate(old)

        if not os.path.exists(self.binary):
            return {"ok": False, "reason": "tuya-ipc-terminal ausente"}

        # A porta precisa estar livre antes de subir o processo novo. Um
        # `bind()`-perdeu significava processo morto + registro de fontes
        # velho na UI — exatamente o zumbi que estamos matando.
        killed = self._kill_stale_listeners()
        if killed:
            self._note_action(f"processo órfão anterior encerrado ({killed})")
        t0 = time.time()
        while self.port_open() and time.time() - t0 < 8:
            time.sleep(0.25)
        if self.port_open():
            return {"ok": False, "reason": f"porta {self.port} ainda ocupada"}

        with self.lock:
            self.generation += 1
            gen = self.generation
            self.cameras = {}
            self.media = {}
            self.dry_since = {}
            self.cam_state = {}
            self.health = {}
            self.health_fails = 0
            self.health_reachable = False
            self.error = ""
            self.error_kind = ""
            self.fatal_reason = ""
            self.log = []
            env = dict(os.environ, NEBULA_BUNDLE=token)
            try:
                proc = subprocess.Popen(
                    [self.binary, "serve", "--port", str(self.port),
                     "--health-port", str(self.health_port),
                     "--connect-timeout", f"{CONNECT_TIMEOUT:.0f}s",
                     "--stall-timeout", f"{STALL_TIMEOUT:.0f}s"],
                    # binário + bufsize=0: a leitura do log é feita com um
                    # BufferedReader explícito (ver _pump). Com text=True o
                    # iterador de stdout do Python entrega as linhas de forma
                    # não-determinística — chegou a perder a linha
                    # NEBULA_RTSP_SOURCES inteira, e sem ela a ponte subia
                    # "sem nenhuma câmera".
                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                    env=env, bufsize=0,
                )
            except Exception as exc:  # noqa: BLE001
                return {"ok": False, "reason": str(exc)[:160]}
            self.proc = proc
            self.started_at = time.time()
            self.token = token

        threading.Thread(target=self._pump, args=(proc, gen), daemon=True).start()

        deadline = time.time() + BOOT_TIMEOUT
        while time.time() < deadline:
            with self.lock:
                cur = self.proc
            if cur is None:
                return {"ok": False, "reason": "processo substituído no boot"}
            if cur.poll() is not None:
                time.sleep(0.35)      # deixa o _pump drenar o resto
                reason = ("porta do RTSP ocupada por outro processo"
                          if self.fatal_reason == "porta_ocupada"
                          else "processo do RTSP saiu")
                return {"ok": False, "reason": reason,
                        "log": "\n".join(self.log[-8:])}
            if self.port_open():
                # O endpoint de saúde respondendo é o sinal real de "no ar";
                # se ele não vier (binário antigo), a porta basta. Damos uma
                # margem curta para o _pump consumir NEBULA_RTSP_SOURCES: sem
                # isso a API voltaria "sem fonte RTSP" logo depois de subir.
                deadline2 = time.time() + 3.0
                while time.time() < deadline2 and not self.cameras:
                    self.poll_health(silent=True)
                    if self.cameras:
                        break
                    time.sleep(0.2)
                return {"ok": True, "started": True, "cameras": len(self.cameras)}
            time.sleep(0.25)
        return {"ok": False, "reason": "timeout subindo o RTSP"}

    def port_open(self) -> bool:
        import socket
        h = self.rtsp_base.split("//")[-1]
        host, _, port = h.partition(":")
        try:
            with socket.create_connection((host, int(port or self.port)), timeout=1.0):
                return True
        except OSError:
            return False

    def _listeners_on(self, port: int) -> list[int]:
        try:
            res = subprocess.run(
                ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
                capture_output=True, text=True, timeout=5)
        except Exception:
            return []
        return [int(p) for p in res.stdout.split() if p.strip().isdigit()]

    def _kill_stale_listeners(self) -> int:
        """
        Encerra um `tuya-ipc-terminal serve` órfão que ainda esteja segurando
        a porta. Só mata processo cujo comando bate com o nosso binário —
        nunca um serviço qualquer do usuário.

        Sem isto, um backend encerrado com `kill -9` deixava o Go vivo, e o
        backend seguinte não conseguia subir: porta ocupada, `/media` replying
        pelo processo velho e fontes de uma sessão que já não existia.
        """
        base = os.path.basename(self.binary)
        if not base or not os.path.exists(self.binary):
            return 0
        killed = 0
        for port in (self.port, self.health_port):
            for pid in self._listeners_on(port):
                try:
                    cmd = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                                         capture_output=True, text=True,
                                         timeout=5).stdout
                except Exception:
                    continue
                if base not in cmd or "serve" not in cmd:
                    continue
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    try:
                        os.kill(pid, sig)
                    except OSError:
                        break
                    time.sleep(0.5)
                    if not self._listeners_on(port):
                        break
                killed += 1
                self._logline(f"órfão {pid} em :{port} encerrado")
        # espera o SO_REUSEADDR do kernel liberar de fato: um connect() falha
        # enquanto o socket está em dying, ebind() ainda dá EADDRINUSE.
        t0 = time.time()
        while time.time() - t0 < 8:
            if not (self._listeners_on(self.port)
                    or self._listeners_on(self.health_port)):
                break
            time.sleep(0.3)
        return killed

    def _pump(self, proc: subprocess.Popen, gen: int) -> None:
        """
        Lê a saída do processo. Só escreve no estado se a geração ainda for a
        atual: o log de um processo morto não pode contaminar o novo (era
        exatamente isso que fazia a UI mentir sobre a causa).
        """
        stream = None
        try:
            if proc.stdout is None:
                return
            stream = io.BufferedReader(proc.stdout, 8192)
            for raw in iter(stream.readline, b""):
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                with self.lock:
                    stale = gen != self.generation or self.proc is not proc
                if stale:
                    continue
                if line.startswith("NEBULA_RTSP_SOURCES "):
                    try:
                        for c in json.loads(line.split(" ", 1)[1]):
                            self.cameras[c["rtspPath"]] = {
                                "path": c["rtspPath"], "name": c.get("deviceName"),
                                "deviceId": c.get("deviceId"),
                            }
                    except Exception:
                        pass
                elif line.startswith("NEBULA_FATAL "):
                    # O detail CONTÉM espaços ("sessao invalida: ...").
                    # Dividir a linha toda em tokens e montar o dict
                    # truncava a causa em "sessao" — que é justamente o
                    # campo que a UI mostra ao usuário.
                    reason, _, rest = line[len("NEBULA_FATAL "):].partition(" ")
                    detail = rest
                    if rest.startswith("detail="):
                        detail = rest[len("detail="):]
                    with self.lock:
                        self.fatal_reason = reason.strip()
                        self.error = detail[:300]
                        self.error_kind = reason.strip()
                        self.action = ("relogin"
                                       if reason.strip().startswith("session")
                                       else "retry")
                    self._logline(f"ponte abortada: {self.error}")
                elif line.startswith("NEBULA_RTSP_READY"):
                    parts = dict(p.split("=", 1) for p in line.split()
                                 if "=" in p)
                    self._note_action(
                        f"RTSP no ar, {parts.get('cameras', '?')} câmera(s)")
                elif not line.startswith("NEBULA_MEDIA "):
                    self._logline(line)
        except Exception:
            pass

    # -- endpoint de saúde -------------------------------------------------
    def poll_health(self, silent: bool = False) -> bool:
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{self.health_port}/media",
                    timeout=HEALTH_TIMEOUT) as r:
                data = json.loads(r.read().decode())
        except Exception:
            with self.lock:
                self.health_fails += 1
                self.health_reachable = False
            return False
        cams = {}
        for c in data.get("cameras") or []:
            cams[c["path"]] = c
        with self.lock:
            self.health = data
            self.media = cams
            self.health_fails = 0
            self.health_reachable = True
            # O erro de sessão é estado, não ruído: precisa ser lido mesmo no
            # poll silencioso, senão `USER_SESSION_INVALID` no Go nunca chega
            # ao backend e o watchdog reinicia a ponte em loop à toa.
            err = data.get("lastSessionError")
            if err:
                self.error = str(err)[:300]
                self.error_kind = str(data.get("lastSessionErrorKind") or "")
                self.action = ("relogin" if self.error_kind in
                               ("session_invalid", "session_incomplete")
                               else "retry")
            elif not silent:
                self.error = ""
                self.error_kind = ""
                self.action = ""
        return True

    def restart_camera(self, path_or_id: str) -> bool:
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.health_port}/restart",
                data=b"", method="POST")
            with urllib.request.urlopen(req, timeout=HEALTH_TIMEOUT) as r:
                return json.loads(r.read().decode()).get("found", False)
        except Exception:
            return False

    def wait_media(self, path: str, budget: float = 15.0) -> bool:
        """Espera o Go reportar mídia fluindo (`state == "live"`) para o stream.

        Por que existe: no primeiro clique em "ver vídeo" o stream já está
        registrado no servidor RTSP mas a ponte ainda está conectando o
        WebRTC/MQTT — o ffmpeg abre, não recebe keyframe/SPS e estoura um
        `TimeoutError` cru na cara do usuário (que desaparece sozinho no
        retry seguinte, mas assusta). Esperar aqui troca o erro por alguns
        segundos de carregamento — o `<img>` fica só aguardando os headers.

        Devolve True se ficou live; False no orçamento esgotado OU quando o Go
        já reportou `failed` (erro real: deixa o leitor mostrar a causa).
        """
        want = (path or "").strip("/")
        if not want:
            return False
        deadline = time.time() + max(0.0, budget)
        while True:
            self.poll_health(silent=True)
            with self.lock:
                cams = list((self.media or {}).values())
            for c in cams:
                p = str(c.get("path") or "").strip("/")
                if p == want or p.startswith(want + "/"):
                    if c.get("state") == "live":
                        return True
                    if c.get("state") == "failed":
                        return False
            if time.time() >= deadline:
                return False
            time.sleep(0.4)

    # -- watchdog ----------------------------------------------------------
    def ensure_watchdog(self) -> None:
        if self._watchdog and self._watchdog.is_alive():
            return
        self._stop_watchdog.clear()
        self._watchdog = threading.Thread(target=self._watch_loop, daemon=True,
                                          name="cam-watchdog")
        self._watchdog.start()

    def _budget_ok(self) -> bool:
        now = _now()
        self.restart_times = [t for t in self.restart_times
                              if now - t < RESTART_WINDOW]
        return len(self.restart_times) < RESTART_BUDGET

    def _restart_process(self, reason: str) -> None:
        bundle = self._last_bundle or {}
        if not (bundle.get("cloud") or {}).get("cookies"):
            self._note_action("reinício adiado: sem sessão no bundle")
            return
        if not self._budget_ok():
            self._note_action(
                f"não reiniciei: {RESTART_BUDGET} restarts em "
                f"{int(RESTART_WINDOW)}s já esgotados (último motivo: {reason})")
            self.error = ("a ponte de vídeo reiniciou muitas vezes seguidas; "
                          "veja o log e refaça o login se persistir")
            self.error_kind = "restart_budget"
            self.action = "retry"
            return
        self.restart_times.append(_now())
        self.process_restarts += 1
        self.restart_log.append(f"{time.strftime('%H:%M:%S')} {reason}")
        del self.restart_log[:-10]
        self._note_action(f"reiniciando o processo da ponte: {reason}")
        # NÃO derruba os leitores: o processo novo fecha os sockets RTSP e o
        # laço de reconexão deles se recupera sozinho. Parar os geradores aqui
        # quebraria a resposta MJPEG em curso a cada reinício.
        try:
            self.manager.reset_status()
        except Exception:
            pass
        out = self.start(bundle, force=True)
        if not out.get("ok"):
            self._note_action(f"reinício falhou: {out.get('reason')}")
            self.error = f"não consegui reiniciar a ponte: {out.get('reason')}"
            self.error_kind = "restart_failed"
            self.action = "retry"
        return out

    def _watch_loop(self) -> None:
        while not self._stop_watchdog.wait(TICK):
            try:
                self._tick()
            except Exception as exc:  # noqa: BLE001
                self._logline(f"watchdog erro: {type(exc).__name__}: {exc}"[:200])

    def _tick(self) -> None:
        # Processo MORTO também é caso do watchdog. Antes ele só olhava
        # processo vivo e mudo: um `kill` (ou um crash) deixava a ponte fora
        # até alguém abrir um request novo, e um MJPEG em curso ficaria preto
        # mesmo com a sessão válida. Aqui a falta de sessão é tratada por
        # _restart_process, que não faz nada sem bundle.
        if not self.alive():
            if self._last_bundle:
                self._restart_process("processo da ponte morreu")
            return

        # Janela de boot: entre o Popen e o bind da porta, o processo existe
        # mas não atende nem no RTSP nem no /media. Sem esta guarda o watchdog
        # reiniciava a cada 3s e a câmera nunca passava do handshake — o
        # sintoma "stream seco" passando a ser auto-infligido.
        with self.lock:
            booting = time.time() - self.started_at < BOOT_TIMEOUT
        if booting:
            return

        ok = self.poll_health(silent=True)

        if not ok:
            with self.lock:
                fails = self.health_fails
            if self.port_open():
                # RTSP de pé mas endpoint de saúde fora: porta ocupada ou binário antigo.
                if fails >= 5:
                    self._restart_process("endpoint de saúde não responde")
            else:
                self._restart_process("porta RTSP fechada")
            return

        now = _now()
        with self.lock:
            media = dict(self.media)
            bundle = self._last_bundle

        if not media:
            return

        readers = {}
        try:
            for r in self.manager.readers():
                readers[r["url"]] = r
        except Exception:
            pass

        dry = []
        for path, cam in media.items():
            state = cam.get("state")
            url = self.rtsp_base + path
            reader = readers.get(url)

            if state == "live":
                self.dry_since.pop(path, None)
                self.cam_state.pop(path, None)
                continue
            if state == "stalled":
                dry.append((path, cam, "stalled no Go (sem RTP)"))
                continue
            if state == "connecting":
                if float(cam.get("connectingForSec") or 0) > CONNECT_TIMEOUT:
                    dry.append((path, cam, "handshake travado"))
                continue
            # state idle + alguém lendo = câmera nunca subiu.
            #
            # Só valida quando o Go NÃO está negociando: durante o handshake
            # (medido: ~14s até o primeiro RTP) o leitor legitimamente fica
            # sem quadro, ederrubar a câmera aí matava um handshake que ia
            # dar certo. Quem julga o handshake é o orçamento do próprio Go.
            if reader and reader["dry_for"] > CAMERA_DRY_DEADLINE:
                dry.append((path, cam, "leitor sem quadros há %.0fs" % reader["dry_for"]))

        if not dry:
            return

        all_dry = len(dry) == len(media)

        # sessão morta? parar é melhor que reiniciar em loop.
        with self.lock:
            err_kind = self.error_kind
            fatal = self.fatal_reason
        if err_kind in ("session_invalid", "session_incomplete"):
            self._note_action("sessão inválida: não vou reiniciar em loop")
            if self._budget_ok():
                self.restart_times.append(_now())
            self.action = "relogin"
            self.stop("sessão inválida")
            return

        for path, cam, why in dry:
            self._handle_dry(path, why, all_dry, bundle)

    def _handle_dry(self, path: str, why: str, all_dry: bool, bundle: dict) -> None:
        """
        Escada de recuperação de UMA câmera:

          t0            derruba a câmera (POST /restart no Go) — nível barato
          t0 + ESC      derruba de novo (às vezes a 1ª oferta ficou presa)
          t0 + 2*ESC    derruba o PROCESSO inteiro

        O contador zera a cada ciclo, então uma queda isolada custa um restart
        de câmera e uma queda persistente custa uma reconstrução completa.
        """
        now = _now()
        st = self.cam_state.setdefault(
            path, {"kicks": 0, "first": now, "last": 0.0})

        if now - st["last"] < CAMERA_ESCALATE:
            return                      # já tentamos há pouco; espera

        st["kicks"] += 1
        st["last"] = now
        hit = self.restart_camera(path)
        try:
            self.manager.drop(self.rtsp_base + path)
        except Exception:
            pass
        self.restarts += 1
        self._note_action(
            f"câmera {path} seca ({why}); tentativa {st['kicks']} de derrubar "
            + ("o stream" if hit else "o stream (pedido falhou)"))

        if st["kicks"] >= 2:
            self._restart_process(
                f"câmera {path} continua seca depois de 2 reinícios: {why}")

    # -- entrada principal -------------------------------------------------
    def sync(self, bundle: dict) -> dict:
        """
        Mantém a ponte coerente com a sessão do bundle. Chamado por TODA rota
        de câmera — é o substituto do antigo `_rtsp_token_changed`, que só
        comparava token e por isso deixava processo zumbi com sessão morta.

        Só levanta (ou desliga) aqui; a recuperação por mídia é do watchdog.
        """
        cloud = bundle.get("cloud") or {}
        has_session = bool(cloud.get("cookies") and cloud.get("host"))

        action, msg = self._session_problem(bundle)
        if action:
            with self.lock:
                self.action = action
                self.error = msg
                self.error_kind = "session_incomplete" if "parcial" in msg else "session_invalid"
            if self.alive():
                self.stop(msg)
            return self.combined()

        if not has_session:
            if self.alive():
                self.stop("sem sessão no bundle")
            with self.lock:
                self.action = ""
                self.error = ""
                self.error_kind = ""
            return self.combined()

        self._last_bundle = bundle
        self.ensure_watchdog()

        if self.alive():
            try:
                token = self._cloud_of(bundle) or ""
            except Exception:
                token = ""
            if token and self.token and token != self.token:
                # sessão diferente no bundle (re-login, outra conta): o
                # processo antigo está com a sessão velha, porta 8554 segue
                # aberta e nada reinicia. Este é o bug original.
                self._note_action("sessão mudou no bundle: reiniciando a ponte")
                self.start(bundle)
        else:
            self.start(bundle)

        with self.lock:
            if self.action and self.action != "relogin":
                self.action = ""
        return self.combined()

    def combined(self) -> dict:
        """status() + state(): o que as rotas e a UI consomem."""
        out = self.status()
        out.update(self.state())
        out["auto"] = True
        return out

    # -- leitura para a API -------------------------------------------------
    def note_reader_event(self, kind: str, status) -> None:
        if kind == "frame":
            with self.lock:
                for path in list(self.dry_since):
                    if self.rtsp_base + path == status.url:
                        self.dry_since.pop(path, None)
                        self.cam_state.pop(path, None)
            return
        if kind == "error":
            self._logline(f"leitor {status.url}: {status.error_kind} {status.error[:80]}")

    def sources(self) -> list[dict]:
        with self.lock:
            out = []
            for path, cam in sorted(self.cameras.items()):
                m = self.media.get(path) or {}
                out.append({
                    "path": path,
                    "name": cam.get("name"),
                    "deviceId": cam.get("deviceId"),
                    "url": self.rtsp_base + path,
                    "media_state": m.get("state", "idle"),
                    "packets": (m.get("media") or {}).get("videoPackets", 0),
                    "bytes": (m.get("media") or {}).get("videoBytes", 0),
                    "keyframes": (m.get("media") or {}).get("keyframes", 0),
                    "packet_age": (m.get("media") or {}).get("lastPacketAgeSec", 0),
                    "clients": m.get("clients", 0),
                    "last_error": m.get("lastError") or "",
                    "error_kind": m.get("errorKind") or "",
                })
        return out

    def state(self) -> dict:
        with self.lock:
            media = [dict(v) for v in self.media.values()]
            streaming = [c for c in media if c.get("state") == "live"]
            return {
                "base": self.rtsp_base,
                "health_port": self.health_port,
                "health_reachable": self.health_reachable,
                "health": {
                    "connect_timeout_sec": CONNECT_TIMEOUT,
                    "stall_timeout_sec": STALL_TIMEOUT,
                    "dry_deadline_sec": CAMERA_DRY_DEADLINE,
                    "cameras_streaming": len(streaming),
                    "cameras_total": len(media),
                },
                "cameras": media,
                "restart_count": self.restarts,
                "process_restarts": self.process_restarts,
                "restart_log": list(self.restart_log[-6:]),
                "last_action": self.last_action,
                "last_action_at": self.last_action_at or None,
                "fatal_reason": self.fatal_reason,
            }

    def status(self) -> dict:
        with self.lock:
            proc = self.proc
            hints = drain_hints()
            log = list(self.log)
            for h in reversed(hints):
                if h not in log:
                    log.append(h)
            return {
                "alive": self.alive(),
                "running": proc is not None and proc.poll() is None,
                "since": self.started_at or None,
                "pid": proc.pid if proc is not None else None,
                "error": self.error,
                "error_kind": self.error_kind,
                "action": self.action,
                "log": "\n".join(log[-40:]),
                "started_at": self.started_at,
            }

    def shutdown(self) -> None:
        self._stop_watchdog.set()
        self.stop("shutdown")