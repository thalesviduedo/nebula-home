"""Nebula Home — API backend. http://127.0.0.1:8765 (somente esta maquina;
NEBULA_HOST/NEBULA_API_PORT/NEBULA_URL/TUYA_RTSP_URL/TUYA_REGION/
TUYA_COUNTRY mudam bind, porta, dashboard, RTSP e região da conta).

Este arquivo e SO backend. Nao ha HTML aqui: a interface vive no app Next
(nebula-web, :3100) e a raiz deste servidor redireciona para la.

  O backend e SEM ESTADO. Nada de localKey, cookie ou codigo IR e gravado em
  disco: tudo chega no header X-Nebula-Bundle (base64 de um JSON) e morre no
  fim da requisicao. Quem guarda o segredo e o navegador.

  POST /api/cloud/login     {email,password} -> bloco cloud para o bundle
  POST /api/cloud/qr/start  -> {token, image(data URL), payload}
  POST /api/cloud/qr/poll   {token} -> bloco cloud quando voce aprovar
  POST /api/registry/apply  {keys} -> quais devices ficaram controlaveis
  POST /api/bundle/preview  -> resumo do bundle (sem segredo)

  GET  /api/devices        lista unificada (nuvem + LAN + chaves do bundle)
  GET  /api/devices?fast=1 mesma lista sem consultar a rede
  /api/status         DPS de um device
  /api/control        liga/desliga/brilho/temp/cor/countdown/IR
  /api/ir/buttons     os 59 codigos IR aprendidos
  /api/scan           varredura Tuya da LAN
  /api/cam/*          RTSP -> MJPEG e telemetria do stream
  /                    302 para o dashboard

Uso: python3 tuya_dash.py
"""
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import tinytuya

import tuya_bundle
import tuya_registry
import tuya_cam
import tuya_rtsp as rtsp_mod

_EXT_MODS = {
    "rooms": "ext_rooms",
    "energy": "ext_energy",
    "scenes": "ext_scenes",
    "device": "ext_device",
    "ipc": "ext_ipc",
}


def ext_dispatch(path, query_string, body, bundle):
    """Roteia /api/ext/<slug>[/<action>] para backend/ext_<slug>.handle.

    Aceita os dois estilos usados pelos painéis: ação no caminho
    (/api/ext/rooms/homes) ou na query (?action=homes). Devolve (http, json).
    """
    import importlib
    from urllib.parse import parse_qs

    rest = path[len("/api/ext/"):]
    seg = rest.split("/", 1)
    flat = {k: v[0] for k, v in parse_qs(query_string).items()}
    action = (seg[1] if len(seg) > 1 else "") or flat.get("action", "")
    modname = _EXT_MODS.get(seg[0] if seg else "")
    if not modname or not action:
        return 404, {"ok": False, "error": "ext desconhecida"}
    try:
        mod = importlib.import_module(modname)
        if not isinstance(body, dict):
            body = {}
        return mod.handle(action, flat, body, bundle)
    except Exception as exc:  # noqa: BLE001
        return 500, {"ok": False, "error": str(exc)[:200]}

REGISTRY = tuya_registry.REGISTRY

# --- layout do projeto ------------------------------------------------------
#   backend/  este arquivo: API Python, sem nenhuma UI
#   frontend/ app Next (:3100)
# Nada fora de backend/ é obrigatório em runtime: sem data/ (dicas de tipo) e
# sem research/ (fatos P2P) o servidor sobe normalmente e só omite extras.
ROOT = os.path.dirname(os.path.abspath(__file__))

# --- configuração -----------------------------------------------------------
# Constantes do protocolo Tuya ficam no código; o que é configuração da
# máquina/instalação tem override por ambiente com default sensato.
PORT = int(os.environ.get("NEBULA_API_PORT", 8765))
# Interface de bind da API. 127.0.0.1 = só esta máquina (padrão).
HOST = os.environ.get("NEBULA_HOST", "127.0.0.1")
DASHBOARD_URL = os.environ.get("NEBULA_URL", "http://127.0.0.1:3100/")
CLOUD_REGION = os.environ.get("TUYA_REGION", "us-west")
# RTSP publicado pelo tuya-ipc-terminal (WebRTC da câmera -> RTSP local)
RTSP_URL = os.environ.get("TUYA_RTSP_URL", "rtsp://127.0.0.1:8554").rstrip("/")
CAM_W = 640  # largura padrão do MJPEG re-emitido
# Orçamento para esperar a mídia fluir antes de abrir o ffmpeg no MJPEG (o
# primeiro clique em "ver vídeo" batia num TimeoutError cru da ponte).
CAM_WAIT_MEDIA = float(os.environ.get("NEBULA_CAM_WAIT_MEDIA", "15"))
# Código de país para login (55 = Brasil). A Tuya não tem região SA; a conta
# cai na America Zone (ver REGIONS em tuya_cloud.py).
COUNTRY = os.environ.get("TUYA_COUNTRY", "55")
IPC_TERM = os.path.join(ROOT, "tools", "tuya-ipc-terminal", "tuya-ipc-terminal")
# Captura real da resposta m.ipc.v4.rtc.config.get (investigação do APK).
# O front lê estes fatos daqui em vez de hardcodar no TypeScript.
# OPCIONAL e fora do pacote: sem o arquivo, `_p2p_facts()` devolve {} e a UI
# só omite o bloco. NEBULA_P2P_CAPTURE aponta para outra captura, se houver.
P2P_CAPTURE = os.environ.get(
    "NEBULA_P2P_CAPTURE",
    os.path.join(os.path.dirname(ROOT), "research", "cam_rtc_config_capture.json"))
# A ponte de vídeo (processo Go + RTSP + MJPEG) é dona de `tuya_cam.CAM`
# abaixo. Ela segura o lock de start/stop e o watchdog; aqui só ficam as
# constantes de configuração.

_LOCKS = {}
_LOCKS_GUARD = threading.Lock()
_COOLDOWN = {}
SCAN = {"running": False, "finished_at": None, "started_at": 0.0,
        "found": [], "changes": []}
SCAN_TIMEOUT = float(os.environ.get("NEBULA_SCAN_TIMEOUT", "45"))
# cada device tem 6s de socket + folga; com 12 em paralelo o pior caso e o
# mais lento, nao a soma. Ainda assim o teto existe para nao derrubar o worker.
STATUS_TIMEOUT = float(os.environ.get("NEBULA_STATUS_TIMEOUT", "4"))
STATUS_WORKERS = int(os.environ.get("NEBULA_STATUS_WORKERS", "16"))


def dev_lock(dev_id):
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(dev_id, threading.Lock())


def throttled(dev_id, fn, cooldown=2.0):
    """Serializa acesso por dispositivo + intervalo mínimo (bulbos v3.5
    derrubam a sessão com rajadas)."""
    with dev_lock(dev_id):
        now = time.monotonic()
        wait = _COOLDOWN.get(dev_id, 0) - now
        if wait > 0:
            time.sleep(wait)
        try:
            return fn()
        finally:
            _COOLDOWN[dev_id] = time.monotonic() + cooldown


def devices(bundle: dict):
    """Lista unificada e sempre atual (nuvem + LAN + chaves do bundle)."""
    return REGISTRY.build(bundle)


# Protocolo de DPS dos blasters IR, por productId — fato GLOBAL do catálogo
# Tuya (qualquer conta com o mesmo modelo usa o mesmo formato):
#   control_type 1 -> DPS 201/202, valor = JSON {"control":"send_ir",...}
#   control_type 2 -> DPS 1-13
# A tabela só desambigua rápido. Produto fora dela NÃO deixa de ser blaster
# (kind/categoria/nome decidem isso em `_ir_candidates`) — na LAN o tinytuya
# detecta o control_type sozinho e, pela nuvem, a emissão fica com erro
# EXPLÍCITO até o produto entrar aqui.
IR_CONTROL_TYPES = {
    "whs3cty93fzrqkpt": 1,  # IR inteligente (ir_send = DP 201)
    "ocfmsqadzl05q0hu": 2,  # Smart IR (DPs 1-13)
}
IR_BLASTER_PRODUCTS = frozenset(IR_CONTROL_TYPES)


def _find_blaster(bundle: dict):
    """Blaster IR em uso: papel explícito primeiro, depois melhor esforço.

    Nenhuma UI jamais atribuiu o papel `ir-blaster`, então após um login
    fresco ele não existe — sem este fallback, nenhum botão do controle IR
    funciona. Prefere quem tem chave+IP; sem IP, aceita quem tem chave (o
    erro final orienta a rodar o scan).
    """
    cands = _ir_candidates(bundle)
    if cands:
        return cands[0]
    return REGISTRY.by_role(bundle, "ir-blaster")


_IR_NAME = re.compile(r"\bir\b", re.IGNORECASE)


def _ir_candidates(bundle: dict) -> list:
    """Todos os candidatos a blaster, com papel explícito primeiro."""
    vault = bundle.get("keys") or {}
    cands = []
    for d in REGISTRY.build(bundle):
        v = vault.get(d["id"]) or {}
        if not v.get("localKey"):
            continue
        pid = str(v.get("productId") or d.get("productId") or "")
        if (d.get("kind") == "ir" or pid in IR_BLASTER_PRODUCTS
                or _IR_NAME.search(str(d.get("name") or ""))):
            cands.append(d)
    cands.sort(key=lambda d: (not d.get("ip"), d.get("name") or ""))
    explicit = REGISTRY.by_role(bundle, "ir-blaster")
    if explicit and explicit.get("key"):
        cands = [explicit] + [c for c in cands if c["id"] != explicit["id"]]
    return cands


def _ir_virtual_default(bundle: dict) -> str:
    """
    Controle virtual IR (TV / ar-condicionado) quando o caller não manda `id`.

    A lista web não os traz — só a 2.2 do gateway móvel, que é onde
    `ir_virtual_remotes` reconhece os controles pelo módulo `infrared`.
    """
    try:
        import tuya_mobile
        remotes = tuya_mobile.ir_virtual_remotes(bundle.get("cloud") or {})
    except Exception:  # noqa: BLE001
        return ""
    for r in remotes:
        if r.get("is_ir_remote"):
            return r["devId"]
    return ""


def _ir_cloud_dps(pid: str, pulse: str, head: str = "") -> dict | None:
    """DPS para emitir IR pela nuvem (como o app faz fora da LAN).

    O formato é o MESMO que o LAN monta em `IRRemoteControlDevice.send_key`
    (tinytuya/Contrib/IRRemoteControlDevice.py) — o blaster só aceita isso;
    mandar o `compressPulse` cru é aceito pela API e ignorado pelo aparelho.

    control_type 1 (ex.: `whs3cty93fzrqkpt`): ir_send = DP 201,
      valor = JSON {"control":"send_ir","type":0,"head":H,"key1":"0"+P}.
    control_type 2 (ex.: `ocfmsqadzl05q0hu`): DPs 1-13 —
      DP 1="send_ir", DP 13=0 (code_type), DP 3=head, DP 4=pulse.

    Produto fora da tabela devolve None: quem chama transforma isso em erro
    explícito em vez de mandar um DPS que o aparelho ignoraria.
    """
    control = IR_CONTROL_TYPES.get((pid or "").lower())
    if control == 1:
        import json as _json
        return {"201": _json.dumps({"control": "send_ir", "type": 0,
                                    "head": head, "key1": "0" + pulse})}
    if control == 2:
        return {"1": "send_ir", "13": 0, "3": head, "4": pulse}
    return None


def _ir_control_type(pid: str):
    """control_type do tinytuya para este produto; None = produto fora do
    catálogo conhecido — o LAN deixa o próprio tinytuya detectar."""
    return IR_CONTROL_TYPES.get((pid or "").lower())


def device(dev_id, bundle: dict):
    for d in devices(bundle):
        if d["id"] == dev_id:
            return d
    return None


def make_dev(dev_id, d=None, bundle=None):
    d = d or device(dev_id, bundle or {})
    if not d:
        raise KeyError(dev_id)
    cls = tinytuya.BulbDevice if d["kind"] == "bulb" else tinytuya.OutletDevice
    dev = cls(dev_id, d["ip"], d["key"])
    try:
        dev.set_version(float(d.get("ver", "3.3")))
    except Exception:
        pass
    dev.set_socketPersistent(False)
    dev.set_socketTimeout(STATUS_TIMEOUT)
    return dev


def decode_energy(dps, kind):
    """Fatores padrão Tuya p/ tomadas: tensão÷10, corrente=mA, potência÷10."""
    out = {}
    if kind != "plug" or not isinstance(dps, dict):
        return out
    try:
        if isinstance(dps.get("20"), (int, float)) and not isinstance(dps.get("20"), bool):
            out["tensao_v"] = round(dps["20"] / 10.0, 1)
        if isinstance(dps.get("18"), (int, float)) and not isinstance(dps.get("18"), bool):
            out["corrente_ma"] = dps["18"]
        if isinstance(dps.get("19"), (int, float)) and not isinstance(dps.get("19"), bool):
            out["potencia_w"] = round(dps["19"] / 10.0, 1)
    except Exception:
        pass
    return out


def is_on(dps, kind):
    if not isinstance(dps, dict):
        return False
    if kind == "bulb":
        return bool(dps.get("20", False))
    return bool(dps.get("1", dps.get("20", False)))


def scan_job(bundle: dict):
    """Casca: garante que `running` volte a False aconteça o que acontecer."""
    try:
        _scan_job_inner(bundle)
    except Exception as exc:  # noqa: BLE001
        SCAN.update(running=False, started_at=0.0, found=[],
                    finished_at=time.time(),
                    changes=[f"erro interno no scan: {type(exc).__name__}: {exc}"[:160]])
    finally:
        SCAN.update(running=False, started_at=0.0)


def _scan_job_inner(bundle: dict):
    """
    Varre a LAN.

    Três defesas porque um scan travado deixa o botão morto para sempre
    (o guard `not SCAN["running"]` ignoraria os próximos cliques):
      1. timeout explícito — `deviceScan` faz ManyToMany em 6667/7000 e uma
         porta fechada pode segurar a thread indefinidamente;
      2. `finally` sempre libera `running`, mesmo com exceção no meio;
      3. carimbo `started_at` permite re-disparar um scan preso.
    """
    import time as _t

    def _scan():
        return tinytuya.deviceScan(verbose=False)

    found, err = {}, None
    done = threading.Event()

    def _worker():
        nonlocal found, err
        try:
            found = _scan()
        except Exception as exc:
            err = exc
        finally:
            done.set()

    threading.Thread(target=_worker, daemon=True).start()
    if not done.wait(SCAN_TIMEOUT):
        SCAN.update(running=False, finished_at=_t.time(), started_at=0.0,
                    found=[], changes=[f"timeout de {SCAN_TIMEOUT}s — a rede não respondeu"])
        return
    if err is not None:
        SCAN.update(running=False, finished_at=_t.time(), started_at=0.0,
                    found=[], changes=[f"erro: {err}"[:120]])
        return
    changes = []
    seen = []
    lan = {}
    known = {d["id"]: d for d in REGISTRY.build(bundle) if d.get("key")}
    for ip, info in sorted(found.items()):
        gid = info.get("gwId") or info.get("id")
        ver = str(info.get("version") or "")
        seen.append({"ip": ip, "gwId": gid, "version": ver})
        if not gid:
            continue
        lan[gid] = {"ip": ip, "version": ver}
        prev = known.get(gid)
        if prev:
            if prev.get("ip") != ip:
                changes.append(f'{prev["name"]}: {prev.get("ip") or "?"} -> {ip}')
        else:
            changes.append(f"novo na rede: {gid} @ {ip} (v{ver})")
        # IP visto na rede é a verdade; some no restart, e o front reenvia
    REGISTRY.set_lan(lan)
    REGISTRY.invalidate()
    # o IP fica só em memória: o navegador guarda o que precisa no bundle
    if not changes:
        changes = [f"{len(seen)} na rede, nada mudou"]
    SCAN.update(running=False, finished_at=_t.time(), started_at=0.0,
                found=seen, changes=changes)


def api_status(dev_id, d=None, bundle=None):
    d = d or device(dev_id, bundle or {})
    if not d:
        return {"ok": False, "dps": {}, "energy": {}, "error": "device desconhecido"}
    can_lan = bool(d.get("key") and d.get("ip"))
    if d["kind"] == "cloud" or (not can_lan and not d.get("remote")):
        return {"ok": False, "dps": {}, "energy": {},
                "error": d.get("note") or "sem IP/chave na LAN"}

    def run():
        try:
            if can_lan:
                s = make_dev(dev_id, d, bundle).status()
                dps = s.get("dps", {}) if isinstance(s, dict) else {}
            else:
                import tuya_mobile
                dps = tuya_mobile.cloud_status(
                    dev_id, bundle.get("cloud") or {}).get("dps", {})
            if not dps:
                return {"ok": False, "dps": {}, "energy": {},
                        "error": "sem resposta (câmera usa P2P p/ vídeo)"}
            return {"ok": True, "dps": dps, "energy": decode_energy(dps, d["kind"])}
        except Exception as e:
            return {"ok": False, "dps": {}, "energy": {}, "error": str(e)[:160]}

    return throttled(dev_id, run, cooldown=1.0)


def api_control(dev_id, action, p, bundle: dict):
    ir_data = bundle.get("ir") or {}
    IR_KEYS = ir_data.get("keys") or {}
    IR_HEAD = ir_data.get("head") or ""
    if action == "ir" and dev_id == "tv-remote":
        from tinytuya.Contrib.IRRemoteControlDevice import IRRemoteControlDevice
        if not IR_KEYS:
            return {"ok": False, "error": "sem códigos IR neste navegador: importe o backup com os códigos aprendidos"}
        key = p.get("button", "power")
        if key not in IR_KEYS:
            return {"ok": False, "error": "botão desconhecido"}

        def run():
            pulse = IR_KEYS[key]["pulse"]
            blaster = _find_blaster(bundle)
            vault = bundle.get("keys") or {}
            if blaster and blaster.get("key") and blaster.get("ip"):
                try:
                    pid = str((vault.get(blaster["id"]) or {}).get("productId")
                              or blaster.get("productId") or "")
                    ir = IRRemoteControlDevice(
                        blaster["id"], blaster["ip"], blaster["key"],
                        version=str(blaster.get("ver") or "3.3"),
                        # produto fora da tabela -> None -> tinytuya detecta
                        control_type=_ir_control_type(pid))
                    ir.set_socketPersistent(False)
                    ir.set_socketTimeout(8)
                    ir.send_key(IR_HEAD, pulse)
                    return {"ok": True, "button": key, "via": "LAN"}
                except Exception:
                    pass
            # sem IP local (ou LAN inalcancavel): emite pela nuvem, como o
            # app faz fora de casa. Tenta cada blaster ate um aceitar.
            import tuya_mobile
            cloud = bundle.get("cloud") or {}
            cands = _ir_candidates(bundle)
            if not cands:
                return {"ok": False, "error": "blaster IR sem chave no cofre"}
            last_err = ""
            sem_formato = []
            for cand in cands:
                pid = str((vault.get(cand["id"]) or {}).get("productId")
                          or cand.get("productId") or "")
                dps = _ir_cloud_dps(pid, pulse, IR_HEAD)
                if not dps:
                    sem_formato.append(pid or cand["id"][:12])
                    continue
                try:
                    tuya_mobile.cloud_publish(cand["id"], dps, cloud)
                    return {"ok": True, "button": key, "via": "nuvem"}
                except Exception as e:  # noqa: BLE001
                    last_err = str(e)[:120]
            if sem_formato:
                # erro explícito em vez de "sem resposta": o aparelho
                # ignoraria em silêncio um DPS de formato errado.
                return {"ok": False, "error":
                        "blaster IR de produto %s sem formato de DP conhecido "
                        "para emitir pela nuvem — funciona só via LAN"
                        % ", ".join(sorted(set(sem_formato)))}
            return {"ok": False, "error": last_err or "blaster IR sem resposta"}

        return throttled("ir-blaster", run, cooldown=2.0)
    d = device(dev_id, bundle)
    if not d:
        return {"ok": False, "error": "device desconhecido"}
    if not (d.get("local") or d.get("remote")):
        return {"ok": False, "error": d.get("note") or "sem controle"}
    if d["kind"] == "ir":
        return {"ok": False, "error": "IR precisa de códigos aprendidos — use o app"}
    if d["kind"] == "cam":
        return {"ok": False, "error": "câmera não tem DPS de controle"}

    def run():
        import tuya_mobile
        use_lan = bool(d.get("local"))
        can_cloud = bool(d.get("remote"))
        cloud = bundle.get("cloud") or {}
        # lâmpada usa DP 20, tomada usa DP 1 (o mesmo do turn_on do tinytuya)
        sw = 20 if d["kind"] == "bulb" else 1

        def read():
            """Devolve (dps, via). LAN primeiro; se o IP estiver obsoleto e
            houver sessão, cai para a nuvem em vez de falhar."""
            if use_lan:
                try:
                    s = make_dev(dev_id, d, bundle).status()
                    dps = s.get("dps", {}) if isinstance(s, dict) else {}
                    if dps:
                        return dps, "LAN"
                except Exception:
                    pass
                if not can_cloud:
                    return {}, "LAN"
            return tuya_mobile.cloud_status(dev_id, cloud).get("dps", {}), "nuvem"

        def send(pairs):
            if use_lan:
                try:
                    dev = make_dev(dev_id, d, bundle)
                    for dp, val in pairs:
                        dev.set_value(dp, val)
                    dps, via = read()
                    if dps:
                        return dps, via
                except Exception:
                    pass
                if not can_cloud:
                    raise RuntimeError("sem resposta na LAN")
            out = tuya_mobile.cloud_publish(
                dev_id, {str(dp): val for dp, val in pairs}, cloud)
            return out.get("dps") or read()[0], "nuvem"

        try:
            if action == "on":
                dps, via = send([(sw, True)])
            elif action == "off":
                dps, via = send([(sw, False)])
            elif action == "toggle":
                cur, _ = read()
                dps, via = send([(sw, not is_on(cur, d["kind"]))])
            elif action == "brightness" and d["kind"] == "bulb":
                dps, via = send([(22, max(10, min(1000, int(p.get("value", 500)))))])
            elif action == "white" and d["kind"] == "bulb":
                dps, via = send([(21, "white")])
            elif action == "temp" and d["kind"] == "bulb":
                dps, via = send([(21, "white"),
                                 (23, max(0, min(1000, int(p.get("value", 500)))))])
            elif action == "color" and d["kind"] == "bulb":
                dps, via = send([(21, "colour"),
                                 (24, tinytuya.BulbDevice.rgb_to_hexvalue(
                                     int(p.get("r", 255)), int(p.get("g", 255)),
                                     int(p.get("b", 255)), "hsv16"))])
            elif action == "countdown" and d["kind"] == "plug":
                dps, via = send([(9, max(0, min(86400, int(p.get("value", 0)))))])
            else:
                return {"ok": False, "error": "ação inválida"}
        except Exception as e:
            return {"ok": False, "dps": {}, "energy": {},
                    "error": str(e)[:160]}
        return {"ok": True, "dps": dps, "energy": decode_energy(dps, d["kind"]),
                "via": via}

    return throttled(dev_id, run, cooldown=2.0)




def _p2p_facts() -> dict:
    """Fatos do P2P lidos da captura real da resposta rtc.config.get.
    Vazio se o arquivo de pesquisa não existir — a UI só omite o bloco."""
    try:
        caps = json.load(open(P2P_CAPTURE, encoding="utf-8")).get("captures") or []
        r = caps[0]["result"]
        pc = r["p2pConfig"]
        skill = json.loads(r["skill"])
        aes = pc["session"]["aesKey"]
        return {
            "device_id": r["id"],
            "is_cloud_p2p": r["isCloudP2P"],
            "p2p_type": r["p2pType"],
            "transmission": pc["transmission"],
            "tcp_relay": pc["tcpRelay"]["urls"],
            "ice_servers": [i["urls"] for i in pc["ices"]],
            "sdk_version": skill.get("sdk_version"),
            "supports_webrtc": r.get("supportsWebrtc"),
            "preconnect": pc.get("preconnect"),
            "codecs": [
                {"stream_type": v["streamType"], "codec_type": v["codecType"],
                 "size": f'{v["width"]}x{v["height"]}'}
                for v in skill.get("videos", [])
            ],
            "audio": skill.get("audios"),
            "source": os.path.relpath(P2P_CAPTURE, os.path.dirname(ROOT)),
        }
    except Exception:
        return {}


def _config(bundle: dict) -> dict:
    """Tudo que a UI precisa saber e que não é dado de device."""
    blaster = _find_blaster(bundle)
    cam = next((d for d in REGISTRY.build(bundle) if d["kind"] == "cam"), None)
    return {
        "region": CLOUD_REGION,
        "country": COUNTRY,
        "dashboard_url": DASHBOARD_URL,
        "rtsp_base": RTSP_URL,
        "api": {"devices": "/api/devices", "scan": "/api/scan",
                "login": "/api/cloud/login", "logout": "/api/cloud/logout",
                "qr": "/api/cloud/qr", "qr_png": "/api/cloud/qr.png",
                "cloud": "/api/cloud/status", "cam": "/api/cam.mjpeg",
                "cam_status": "/api/cam.status", "cam_sources": "/api/cam/sources",
                "ir": "/api/ir/buttons", "kind": "/api/registry/kind"},
        "ir_blaster": None if not blaster else {
            "id": blaster["id"], "name": blaster["name"],
            "ip": blaster["ip"], "version": blaster.get("ver")},
        "camera": None if not cam else {
            "id": cam["id"], "name": cam["name"], "ip": cam["ip"]},
        "p2p": _p2p_facts(),
    }


def _cloud_status(bundle: dict, bundle_rtsp: dict) -> dict:
    """Estado da conta segundo o bundle que veio no request."""
    cloud = bundle.get("cloud") or None
    return {
        "logged_in": bool(cloud),
        "sessions": ([{
            "email": cloud.get("email"), "region": cloud.get("region"),
            "host": cloud.get("host"), "uid": cloud.get("uid"),
            "cookies": len(cloud.get("cookies") or []),
            # QR entrega só cookies: sem accessToken não há controle remoto,
            # IR nuvem nem MQTT da câmera — só lista e P2P
            "full": bool(cloud.get("accessToken") or ""),
        }] if cloud else []),
        "region": (cloud or {}).get("region") or CLOUD_REGION,
        "rtsp": {k: bundle_rtsp.get(k) for k in
                 ("base", "alive", "auto", "since", "error", "error_kind",
                  "action", "last_action", "restart_count")},
        "pyav": rtsp_mod.av is not None,
        "ipc_terminal": os.path.exists(IPC_TERM),
        "bundle": tuya_bundle.describe(bundle),
    }


def _rtsp_sources() -> list:
    """Câmeras publicadas pelo tuya-ipc-terminal — em memória.

    Não há sessão em disco, então o registry do RTSP vive no processo e é
    reconstruído a cada start. Cada fonte carrega o estado real de mídia
    (o Go conta pacotes RTP), não só "o stream existe".
    """
    return CAM.sources()


def _bundle_cloud_of(bundle: dict) -> str:
    """Bundle enxuto so com o bloco cloud — e o que o `serve` precisa."""
    cloud = bundle.get("cloud") or {}
    if not cloud.get("cookies") or not cloud.get("host"):
        return ""
    cloud = dict(cloud)
    if not cloud.get("mobileMqttsUrl"):
        cloud["mobileMqttsUrl"] = _mobile_mqtts_url(cloud)
    return tuya_bundle.serialize({"keys": {}, "cloud": cloud, "ir": None})


_MQTT_URL_CACHE: dict[str, tuple[str, float, float]] = {}


def _mobile_mqtts_url(cloud: dict) -> str:
    """`mobileMqttsUrl` para o terminal Go, com cache por uid.

    O login web não devolve `domain` — buscamos em `user.info.get` (que
    devolve o domain completo, `m1.tuyaus.com` na região US) uma vez e
    reaproveitamos. Sem isso o Go disca `:443` vazio e a câmera nunca sobe.
    """
    uid = str(cloud.get("uid") or "")
    now = time.time()
    hit = _MQTT_URL_CACHE.get(uid)
    if hit and now - hit[1] < hit[2]:
        return hit[0]
    url = ""
    try:
        import tuya_mobile
        sid, ecode, endpoint = tuya_mobile.session_from_cloud(cloud)
        if ecode:
            r = tuya_mobile.call("smartlife.m.user.info.get", {}, sid=sid,
                                 ecode=ecode, endpoint=endpoint, timeout=15)
            for node in tuya_mobile._walk(r):
                if isinstance(node, dict) and node.get("mobileMqttsUrl"):
                    url = str(node["mobileMqttsUrl"])
                    break
    except Exception as exc:
        # resposta de sessão morta aqui é a origem do vazio silencioso
        tuya_cam._log_hint(f"mobileMqttsUrl indisponível: {type(exc).__name__}")
        url = ""
    _MQTT_URL_CACHE[uid] = (url, now, 3600.0 if url else 300.0)
    return url


# ---------------------------------------------------------------------------
# Ponte de vídeo: dono do processo Go, do watchdog e do estado acionável.
# Toda a lógica saiu de _rtsp_start/_rtsp_stop/_rtsp_state — ver tuya_cam.py
# para o porquê de cada nível de recuperação.
# ---------------------------------------------------------------------------
CAM = tuya_cam.CamBridge(
    binary=IPC_TERM,
    rtsp_base=RTSP_URL,
    port=int(RTSP_URL.rsplit(":", 1)[-1]),
    manager=rtsp_mod.MANAGER,
    cloud_of=_bundle_cloud_of,
    mqtt_url_of=_mobile_mqtts_url,
)


def _rtsp_stop() -> None:
    CAM.stop("manual")


def _rtsp_start(bundle: dict) -> dict:
    return CAM.start(bundle)


def _rtsp_state(bundle: dict) -> dict:
    st = CAM.status()
    st.update(CAM.state())
    st["auto"] = True
    return st


def _rtsp_alive() -> bool:
    """Checa se o tuya-ipc-terminal esta de pé na porta do RTSP."""
    return CAM.alive() and CAM.port_open()



# ---------------------------------------------------------------------------
# Login: nada é gravado. O QR vira data URL e os cookies voltam no bundle.
# ---------------------------------------------------------------------------
_QR: dict = {}   # token -> {"created": ts, "host": str}  só memória


def _qr_png_data_url(payload: str) -> str | None:
    try:
        import base64
        import io

        import qrcode
    except ImportError:
        return None
    img = qrcode.make(payload)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _qr_new(bundle: dict) -> dict:
    """Gera um token de QR novo. Devolve o token e a imagem (data URL)."""
    import tuya_cloud

    cloud = (bundle.get("cloud") or {})
    region = cloud.get("region") or CLOUD_REGION
    host = tuya_cloud.host_for(region)
    sess = tuya_cloud.new_client(host)
    token = tuya_cloud.request_qr_token(host, sess)
    _QR.clear()
    _QR[token] = {"created": time.time(), "host": host, "region": region}
    # expira por老化: nada além do token fica guardado
    return {
        "token": token,
        "payload": tuya_cloud.qr_payload(token),
        "image": _qr_png_data_url(tuya_cloud.qr_payload(token)),
        "region": region,
        "host": host,
        "poll": "/api/cloud/qr/poll",
    }


def _qr_poll(token: str) -> dict:
    import tuya_cloud

    meta = _QR.get(token)
    if not meta:
        return {"ok": False, "state": "expirado", "msg": "token de QR desconhecido"}
    if time.time() - meta["created"] > 600:
        _QR.pop(token, None)
        return {"ok": False, "state": "expirado", "msg": "token expirou; gere outro"}
    host, region = meta["host"], meta["region"]
    sess = tuya_cloud.new_client(host)
    try:
        result, cookies = tuya_cloud.poll_login(host, token, sess, timeout=1)
    except Exception as exc:  # ainda nao aprovou no app
        return {"ok": False, "state": "aguardando", "msg": str(exc)[:160]}
    _QR.pop(token, None)
    cloud = tuya_cloud.cloud_block(host, region, result, cookies)

    # mesma coisa do login por senha: tenta entregar as chaves junto
    keys, warn = tuya_cloud.list_device_keys(
        result, (cloud.get("cookies") or []))

    return {"ok": True, "state": "autenticado", "cloud": cloud,
            "keys": keys, "warning": warn}


# ---------------------------------------------------------------------------
# Diagnóstico acionável para a UI.
def _diagnose(st: dict, path: str, readers: list) -> dict:
    """
    Traduz estado técnico em (causa, o que fazer). A UI mostra isso em vez
    de "InvalidDataError", que não dizia nada.

    A ordem importa: causa de sessão vem antes de causa de mídia, porque
    reiniciar a ponte não conserta uma sessão morta.
    """
    action = st.get("action") or ""
    err = (st.get("error") or "").strip()
    kind = st.get("error_kind") or ""
    reader = next((r for r in readers if r["url"].endswith(path or "\0")), None)
    cam = next((c for c in (st.get("cameras") or []) if c.get("path") == path), None)

    if action == "relogin":
        return {"cause": err or "sessão expirada na nuvem",
                "fix": "refaça o login com e-mail e senha",
                "action": "relogin", "retryable": True}
    if not st.get("alive") and err:
        return {"cause": err, "fix": "a ponte será levantada no próximo pedido",
                "action": "retry", "retryable": True}
    if cam and cam.get("state") == "stalled":
        detail = cam.get("lastError") or "a câmera parou de enviar RTP"
        return {"cause": f"câmera sem mídia ({cam.get('state')}): {detail}",
                "fix": "o watchdog está reconstruindo a ponte; se persistir, "
                       "feche o app no celular (a câmera aceita um cliente por vez)",
                "action": "retry", "retryable": True}
    if cam and cam.get("state") == "connecting":
        secs = cam.get("connectingForSec") or 0
        return {"cause": f"negociando WebRTC com a câmera há {secs:.0f}s",
                "fix": "normal nos primeiros segundos; se passar de "
                       f"{tuya_cam.CONNECT_TIMEOUT:.0f}s o watchdog reinicia",
                "action": "wait", "retryable": True}
    if reader and reader["dry_for"] > 8 and reader["state"] != "live":
        return {"cause": f"{reader['error_kind']}: {reader['error'] or 'stream sem quadros'}",
                "fix": "o watchdog tenta derrubar a câmera e depois a ponte",
                "action": "retry", "retryable": True}
    if cam and cam.get("state") == "live":
        return {"cause": "transmitindo", "fix": "", "action": "none",
                "retryable": False}
    if kind:
        return {"cause": err or kind, "fix": "tente novamente",
                "action": "retry", "retryable": True}
    return {"cause": "", "fix": "", "action": "none", "retryable": True}

# ---------------------------------------------------------------------------
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    # -- infra ------------------------------------------------------------
    def bundle(self) -> dict:
        """Segredo do dono, no header. Vive só durante a requisição."""
        return tuya_bundle.parse(self.headers.get(tuya_bundle.HEADER))

    def body(self) -> dict:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}
        except (ValueError, TypeError):
            return {}

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", f"Content-Type, {tuya_bundle.HEADER}")
        super().end_headers()

    def do_OPTIONS(self):
        # HTTP/1.1 exige tamanho de corpo conhecido: um 200 sem Content-Length
        # deixa o browser esperando o body para sempre e trava o preflight de
        # qualquer requisição que use X-Nebula-Bundle.
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def send_json(self, obj, code=200):
        try:
            b = json.dumps(obj, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _frame_error(self, exc):
        try:
            self.wfile.write(b"--frame\r\nX-Error: " + str(exc)[:180].encode() + b"\r\n")
        except Exception:
            pass

    def do_GET(self):
        self._route(urlparse(self.path))

    def _sync_rtsp(self, b: dict) -> dict:
        """Mantem a ponte RTSP coerente com a sessao do bundle.

        Serializado em `tuya_cam.CamBridge.sync`: duas requisições
        simultâneas (o MJPEG de uma aba e o poll de /api/cam.status de outra)
        não podem mais spawnar dois processos — o segundo perdia o bind da
        porta 8554 e deixava o registry poluído com as fontes do processo
        morto.
        """
        return CAM.sync(b)

    def do_POST(self):
        u = urlparse(self.path)
        b = self.bundle()
        if u.path == "/api/cloud/login":
            return self._login(b)
        if u.path == "/api/cloud/qr/start":
            try:
                return self.send_json(_qr_new(b))
            except Exception as exc:
                return self.send_json({"ok": False, "error": str(exc)[:200]}, 400)
        if u.path == "/api/cloud/qr/poll":
            return self.send_json(_qr_poll((self.body().get("token") or "").strip()))
        if u.path == "/api/registry/apply":
            return self._apply_keys(b, self.body())
        if u.path == "/api/bundle/preview":
            return self.send_json(tuya_bundle.describe(b))
        if u.path.startswith("/api/ext/"):
            code, out = ext_dispatch(u.path, u.query, self.body(), b)
            return self.send_json(out, code)
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- login -------------------------------------------------------------
    def _login(self, bundle: dict):
        d = self.body()
        email = (d.get("email") or "").strip()
        password = d.get("password") or ""
        if not email or not password:
            return self.send_json({"ok": False, "error": "informe e-mail e senha"}, 400)
        try:
            import tuya_cloud
            out = tuya_cloud.password_login(
                email, password,
                region=d.get("region") or CLOUD_REGION,
                country_code=str(d.get("country") or COUNTRY),
            )
        except Exception as exc:  # noqa: BLE001
            return self.send_json({"ok": False, "error": str(exc)[:200]}, 401)

        # lista a conta na hora: o gateway móvel é o único que devolve localKey,
        # então o navegador já sai do login com os dispositivos prontos
        keys, warn = tuya_cloud.list_device_keys(
            out.get("loginResult") or {}, (out.get("cloud") or {}).get("cookies") or [])

        # devolve o bloco cloud: o navegador guarda, o servidor não
        return self.send_json({"ok": True, "uid": out.get("uid"),
                               "email": out.get("email"), "cloud": out["cloud"],
                               "keys": keys, "warning": warn})

    def _apply_keys(self, bundle: dict, d: dict):
        """
        Confere as chaves que o navegador trouxe contra o que a nuvem conhece.
        Devolve quais devices agora têm chave utilizável — nada é salvo aqui.
        """
        keys = d.get("keys") or {}
        if not isinstance(keys, dict):
            return self.send_json({"ok": False, "error": "keys inválido"}, 400)
        merged = dict(bundle.get("keys") or {})
        merged.update({k: v for k, v in keys.items() if isinstance(v, dict)})
        probe = {**bundle, "keys": merged}
        devices = devices_list(probe)
        usable = [d_["id"] for d_ in devices
                  if d_.get("local") or d_.get("remote")]
        return self.send_json({"ok": True, "usable": usable,
                               "total": len(devices), **_config(probe)})

    # -- rotas -------------------------------------------------------------
    def _route(self, u):
        b = self.bundle()
        p = u.path

        if p == "/":
            self.send_response(302)
            self.send_header("Location", DASHBOARD_URL)
            self.send_header("Content-Length", "0")
            self.end_headers()

        elif p == "/api/config":
            self.send_json(_config(b))

        elif p == "/api/devices":
            fast = parse_qs(u.query).get("fast", ["0"])[0] == "1"
            all_d = devices_list(b)
            src = REGISTRY.source(b)

            def one(d):
                base = {"id": d["id"], "name": d["name"], "kind": d["kind"],
                        "ip": d.get("ip"), "category": d.get("category") or None,
                        "productId": d.get("productId") or None,
                        "local": d["local"], "remote": bool(d.get("remote")),
                        "virtual": d["virtual"],
                        "note": d.get("note")}
                # controlável = na LAN ou pela nuvem (o app relay pelo gateway)
                controllable = d["local"] or d.get("remote")
                if fast:
                    return {**base, "ok": controllable, "on": False,
                            "dps": {}, "energy": {}}
                # Câmera e blaster IR não têm DPS de estado útil: sondá-los
                # produzia "sem resposta/offline" — mentira. O "ok" deles é a
                # CAPACIDADE: câmera = sessão (a ponte P2P usa a conta);
                # blaster = sessão (o comando vai por DP publish na nuvem).
                if d["kind"] == "cam":
                    # O "online" da câmera é a PONTE DE VÍDEO no ar — é o que
                    # a aba da câmera mostra (RTSP "no ar"). Dizer "vídeo" fixo
                    # aqui fazia o card discordar da aba; dizer "offline" sem
                    # medir era mentira. `CAM.status()` é barato (não sonda).
                    cst = CAM.status()
                    ok = bool(cst.get("alive"))
                    return {**base, "ok": ok, "on": False,
                            "dps": {}, "energy": {},
                            "error": None if ok else
                                     (cst.get("error") or
                                      "ponte de vídeo fora do ar — abra a câmera "
                                      "para subir (precisa da conta conectada)")}
                if d["kind"] == "ir":
                    ready = bool(d.get("remote"))
                    return {**base, "ok": ready, "on": False,
                            "dps": {}, "energy": {},
                            "error": None if ready else
                                     "sem sessão: o comando IR vai pela nuvem"}
                if not controllable:
                    return {**base, "ok": False, "on": False, "dps": {}, "energy": {},
                            "note": d.get("note") or "sem controle"}
                r = api_status(d["id"], d, b)
                dps = r.get("dps", {}) if r["ok"] else {}
                return {**base, "ok": r["ok"], "on": is_on(dps, d["kind"]),
                        "dps": dps, "energy": r.get("energy", {}),
                        "error": r.get("error")}

            if fast:
                out = [one(d) for d in all_d]
            else:
                # so status tem custo; a lista em si e instantanea
                with ThreadPoolExecutor(max_workers=STATUS_WORKERS) as ex:
                    out = list(ex.map(one, all_d))
            # online primeiro, offline depois (estável: preserva a ordem
            # anterior dentro de cada grupo)
            out.sort(key=lambda d: not d.get("ok"))
            self.send_json({"devices": out, "source": src})

        elif p == "/api/status":
            dev_id = parse_qs(u.query).get("id", [""])[0]
            d = device(dev_id, b)
            if not d:
                return self.send_json({"ok": False, "error": "id desconhecido"}, 404)
            r = api_status(dev_id, d, b)
            dps = r.get("dps", {}) if r["ok"] else {}
            self.send_json({"id": dev_id, "name": d["name"], "kind": d["kind"],
                            "ip": d.get("ip"), "ok": r["ok"],
                            "on": is_on(dps, d["kind"]), "local": d["local"],
                            "remote": bool(d.get("remote")),
                            "dps": dps, "energy": r.get("energy", {}),
                            "note": d.get("note"), "error": r.get("error")})

        elif p == "/api/scan":
            q = parse_qs(u.query)
            if q.get("go", ["0"])[0] == "1":
                # trava com carimbo de tempo: se o scan anterior morreu sem
                # liberar o flag, um novo clique precisa conseguir passar
                started = SCAN["started_at"] or 0
                if not SCAN["running"] or (time.time() - started) > SCAN_TIMEOUT + 5:
                    SCAN.update(running=True, found=[], changes=[],
                                started_at=time.time())
                    threading.Thread(target=scan_job, args=(b,), daemon=True).start()
            self.send_json({"running": SCAN["running"],
                            "finished_at": SCAN["finished_at"],
                            "found": SCAN["found"], "changes": SCAN["changes"],
                            "lan": {gid: {"ip": v["ip"], "ver": v["version"]}
                                    for gid, v in REGISTRY.lan().items()}})

        elif p == "/api/cloud/status":
            self.send_json(_cloud_status(b, self._sync_rtsp(b)))

        elif p == "/api/cam/sources":
            st = self._sync_rtsp(b)
            self.send_json({"base": RTSP_URL, "alive": st["alive"],
                            "auto": st["auto"], "error": st["error"],
                            "error_kind": st.get("error_kind", ""),
                            "action": st.get("action", ""),
                            "log": st["log"],
                            "restart_count": st.get("restart_count", 0),
                            "last_action": st.get("last_action", ""),
                            "sources": _rtsp_sources(),
                            "pyav": rtsp_mod.av is not None})

        elif p == "/api/cam.status":
            q = parse_qs(u.query)
            url = q.get("url", [""])[0]
            target = RTSP_URL + url
            st = self._sync_rtsp(b)
            readers = rtsp_mod.MANAGER.readers()
            out = {"rtsp_base": RTSP_URL, "rtsp_path": url, "target": target or None,
                   "mode": "rtsp", "has_av": rtsp_mod.av is not None,
                   "alive": st["alive"], "auto": st["auto"],
                   "error": st["error"],
                   "error_kind": st.get("error_kind", ""),
                   "action": st.get("action", ""),
                   "log": st["log"],
                   "watchdog": {
                       "health_reachable": st.get("health_reachable", False),
                       "health": st.get("health", {}),
                       "cameras": st.get("cameras", []),
                       "restart_count": st.get("restart_count", 0),
                       "process_restarts": st.get("process_restarts", 0),
                       "restart_log": st.get("restart_log", []),
                       "last_action": st.get("last_action", ""),
                       "last_action_at": st.get("last_action_at"),
                       "pid": st.get("pid"),
                   },
                   "sources": _rtsp_sources(),
                   "streams": rtsp_mod.MANAGER.statuses(),
                   "readers": readers,
                   "diagnosis": _diagnose(st, url, readers)}
            if q.get("probe", ["0"])[0] == "1" and target:
                out["probe"] = rtsp_mod.MANAGER.probe(target)
            self.send_json(out)

        elif p == "/api/cam.mjpeg":
            self._mjpeg(u)

        elif p == "/api/ir/buttons":
            self.send_json({"count": len((b.get("ir") or {}).get("keys") or {}),
                            "buttons": _ir_buttons(b)})

        elif p == "/api/ir/cloud-keys":
            q = parse_qs(u.query)
            dev_id = q.get("id", [""])[0]
            learned = q.get("learned", ["0"])[0] not in ("0", "", "false")
            try:
                cloud = b.get("cloud") or {}
                if not dev_id:
                    dev_id = _ir_virtual_default(b)
                    if not dev_id:
                        return self.send_json({
                            "ok": False,
                            "error": "informe ?id=<devId do controle virtual IR> "
                                     "(a lista da nuvem não traz os controles "
                                     "virtuais; pegue o devId no app)"}, 400)
                import tuya_mobile
                out = tuya_mobile.ir_cloud_keys(
                    dev_id, cloud, with_learned=learned,
                    gid=q.get("gid", [""])[0])
                if out.get("error"):
                    return self.send_json({"ok": False, "devId": dev_id,
                                           "error": out["error"]}, 200)
                # mesmo formato do bloco `ir` do bundle: o front só precisa
                # guardar `head` + `keys` para os botões passarem a funcionar.
                # Vai enxuto de propósito — o bloco viaja dentro do header a
                # cada requisição; os quadros decodificados ficam só na amostra.
                ir_keys = {k: {"name": v.get("name") or k,
                               "pulse": v.get("pulse", ""),
                               "keyId": v.get("keyId"),
                               "freq": v.get("freq")}
                           for k, v in out["keys"].items()}
                ir_block = {"head": out["head"], "keys": ir_keys}
                sample = next(iter(out["keys"].values()), None)
                self.send_json({
                    "ok": True, "devId": dev_id,
                    "gwId": out["gwId"], "remoteId": out["remoteId"],
                    "devTypeId": out["devTypeId"],
                    "brandName": out.get("brandName"),
                    "devTypeName": out.get("devTypeName"),
                    "study": out.get("study"),
                    "head": out["head"], "head_info": out["head_info"],
                    "count": out["count"], "ir": ir_block,
                    "sample": sample,
                    "bundle_bytes": len(tuya_bundle.serialize(
                        {"keys": (b.get("keys") or {}),
                         "cloud": b.get("cloud"), "ir": ir_block})),
                    "learned": out.get("learned") or [],
                    "learned_count": out.get("learned_count", 0),
                    "learned_error": out.get("learned_error"),
                    "buttons": [{"key": k, "label": IR_LABELS.get(
                        k, (v.get("name") or k).replace("_", " ").title())}
                        for k, v in out["keys"].items()],
                })
            except Exception as exc:  # noqa: BLE001
                self.send_json({"ok": False, "devId": dev_id,
                                 "error": str(exc)[:220]}, 200)

        elif p == "/api/control":
            q = parse_qs(u.query)
            dev_id = q.get("id", [""])[0]
            action = q.get("action", [""])[0]
            if dev_id != "tv-remote" and not device(dev_id, b):
                return self.send_json({"ok": False, "error": "id desconhecido"}, 404)
            try:
                r = api_control(dev_id, action, {k: v[0] for k, v in q.items()}, b)
                if dev_id == "tv-remote":
                    return self.send_json(r)
                d = device(dev_id, b) or {}
                if r.get("ok"):
                    r["on"] = is_on(r.get("dps", {}), d.get("kind", "cloud"))
                self.send_json(r)
            except Exception as exc:  # noqa: BLE001
                self.send_json({"ok": False, "error": str(exc)[:200]}, 500)

        elif p.startswith("/api/ext/"):
            code, out = ext_dispatch(p, u.query, {}, b)
            return self.send_json(out, code)

        else:
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()

    def _mjpeg(self, u):
        """A câmera não abre porta na LAN: o vídeo vem do relay de nuvem via
        WebRTC, publicado como RTSP local pelo tuya-ipc-terminal."""
        q = parse_qs(u.query)
        url = q.get("url", [""])[0]
        # Garante a ponte antes de abrir o stream — MAS só quando a requisição
        # traz o bundle. O <img> do MJPEG não consegue mandar header nenhum:
        # sincronizar com bundle vazio caía em "sem sessão no bundle" e
        # DERRUBAVA a ponte que estava no ar (o watchdog religava, o <img>
        # voltava a matar — loop). Sem header, só olhamos o estado.
        raw_bundle = self.headers.get(tuya_bundle.HEADER)
        st = self._sync_rtsp(tuya_bundle.parse(raw_bundle)) if raw_bundle else {}
        try:
            width = int(q.get("w", ["0"])[0] or 0)
        except ValueError:
            width = 0
        width = width if 160 <= width <= 1920 else CAM_W
        self.send_response(200)
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        if not url:
            return self._frame_error("informe url=<caminho rtsp>. veja /api/cam/sources")
        if not _rtsp_alive():
            st = CAM.status()
            why = (st.get("error") or "").strip()
            if st.get("action") == "relogin":
                return self._frame_error(f"{why} — refaça o login com e-mail e senha")
            return self._frame_error(
                f"{RTSP_URL} fora do ar — {why or 'a ponte de vídeo não subiu'}")
        # Ponte no ar: espera a MÍDIA fluir antes de abrir o ffmpeg. Sem isto,
        # o primeiro clique em "ver vídeo" abre o PyAV contra um stream
        # registrado mas ainda sem keyframe (WebRTC/MQTT conectando) e o
        # usuário leva um `TimeoutError` cru que some no retry seguinte.
        # Com sessão problemática o erro já é claro — não espera.
        if not (st or {}).get("action"):
            CAM.wait_media(url, budget=CAM_WAIT_MEDIA)
        try:
            bridge = rtsp_mod.MANAGER.bridge(
                RTSP_URL + url, width=width, on_event=CAM.note_reader_event)
            for jpg in bridge.jpeg_frames():
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n")
                if self.wfile._sock is None:
                    break
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            self._frame_error(exc)


IR_LABELS = {
    "power": "Power", "mute": "Mudo", "volume_up": "Vol +", "volume_down": "Vol −",
    "channel_up": "CH +", "channel_down": "CH −", "navigate_up": "↑",
    "navigate_down": "↓", "navigate_left": "←", "navigate_right": "→", "ok": "OK",
    "menu": "Menu", "back": "Voltar", "exit": "Sair", "homepage": "Início",
    "source": "Entrada", "input": "Entrada", "rewind": "Recuar", "play": "Play",
    "fast_forward": "Avançar", "pause": "Pausar", "stop": "Parar", "record": "Gravar",
    "guide": "Guia", "info": "Info", "list": "Lista", "options": "Opções",
    "red": "Vermelho", "green": "Verde", "yellow": "Amarelo", "blue": "Azul",
}


def _ir_buttons(bundle: dict) -> list:
    keys = (bundle.get("ir") or {}).get("keys") or {}
    out = []
    for k in keys:
        label = IR_LABELS.get(k, k.replace("_", " ").title())
        out.append({"key": k, "label": label})
    # numéricos sempre por último, na ordem
    out.sort(key=lambda x: (0 if x["key"].isdigit() else 1,
                            int(x["key"]) if x["key"].isdigit() else 0,
                            x["key"]))
    return out


def devices_list(bundle: dict) -> list:
    return devices(bundle)


def _install_shutdown_hooks() -> None:
    """
    Derruba o processo Go quando o backend sai.

    `atexit` sozinho não basta: SIGTERM (o que `kill` manda) não roda atexit,
    e o processo órfão continuava segurando 8554/8555 — o backend seguinte
    falhava o bind, o `restart` caía no `/media` do processo velho e a UI
    mostrava fontes de uma sessão que já não existia.
    """
    import signal

    def bye(signum, _frame):
        try:
            CAM.shutdown()
        finally:
            sys.exit(0)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, bye)
        except (ValueError, OSError):
            pass
    # SIGHUP NÃO derruba: ele chega quando o terminal/sessão que lançou o
    # processo fecha — e instalar handler para ele anula o `nohup` (que só
    # ignora SIGHUP enquanto ninguém o captura). Era isso que matava o
    # backend e, pelo hook, o processo Go junto, sempre que a sessão de shell
    # ia embora. Ignorar é o comportamento que o `nohup` promete.
    try:
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
    except (ValueError, OSError, AttributeError):
        pass
    import atexit
    atexit.register(CAM.shutdown)


if __name__ == "__main__":
    _install_shutdown_hooks()
    empty = tuya_bundle.empty()
    ds = devices(empty)
    print(f"API em http://{HOST}:{PORT}  ·  dashboard em {DASHBOARD_URL}")
    print("  backend SEM ESTADO: segredos chegam no header "
          f"{tuya_bundle.HEADER}")
    print(f"  {len(ds)} dispositivos visíveis sem bundle — "
          "envie as chaves para controlar")
    print(f"  watchdog de câmera: seco >{tuya_cam.CAMERA_DRY_DEADLINE:.0f}s derruba a "
          f"câmera, >{tuya_cam.CAMERA_ESCALATE:.0f}s derruba a ponte")
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
