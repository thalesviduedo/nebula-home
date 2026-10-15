"""
Ponte RTSP -> MJPEG para o dashboard.

A camera nao expoe nenhuma porta na LAN (verificado: 22/80/443/554/8000/8080/
8443/8899/34567 todos fechados), entao nao existe RTSP local. O video chega
pela internet: o app negocia WebRTC na nuvem Tuya e a `tuya-ipc-terminal`
converte esse WebRTC em um RTSP local em 127.0.0.1:8554.

Este modulo le esse RTSP (H.264 ou H.265), decodifica com PyAV e re-emite
quadros JPEG num fluxo multipart/x-mixed-replace -- o mesmo formato que o
navegador ja consome em <img src=".../api/cam.mjpeg">. Ou seja: a imagem no
dashboard passa a vir do stream real, sem emulador e sem screencap.

O QUE MUDOU (e por que o `InvalidDataError` era recorrente)
----------------------------------------------------------
O `av.open()` antigo era feito com `timeout=10.0` — que vale só para o
*open*. Depois disso, `container.decode()` ficava bloqueado para sempre
quando o stream existia mas não vinha mídia nenhuma (stream "zumbi" publicado
pelo tuya-ipc-terminal). O gerador não emitia quadro, não emitia erro, não
terminava: o `<img>` do navegador ficava preto e o backend não tinha nada
para reportar.

Agora:
  * `timeout=(open_timeout, read_timeout)` — cada demux sem byte estoura e
    vira um erro nomeado, então "stream seco" é detectado em segundos, não em
    silêncio;
  * prazo de primeiro quadro por tentativa (`first_frame_deadline`): se não
    chegar quadro, a tentativa é considerada falha e reconecta com backoff;
  * o `container.close()` está no `finally` com a variável já inicializada —
    antes, um erro no `av.open()` causava `NameError` dentro do `finally`,
    que ESCAPAVA do gerador e derrubava a resposta HTTP inteira;
  * `StreamStatus` conta bytes/quadros e guarda `dry_for`, `attempts` e
    `last_error` — o watchdog do backend (tuya_cam.py) lê isso para decidir
    entre reconectar o leitor ou reconstruir a ponte.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Iterator

try:
    import av  # PyAV: wheels com ffmpeg embutido, dispensa binario externo
except ImportError:  # pragma: no cover
    av = None

# Tempos padrão. Todos sobrescritíveis por ambiente para teste.
OPEN_TIMEOUT = float(__import__("os").environ.get("NEBULA_RTSP_OPEN_TIMEOUT", "10"))
# Tempo sem byte na conexão antes de o demuxer desistir.
#
# Tem que ser MAIOR que o handshake WebRTC, não "o tempo de um frame":
# medido ao vivo, a câmera SMBC1BS1 leva ~14s entre o PLAY e o primeiro RTP
# (MQTT + oferta + answer + ICE + primeiro keyframe). Com 8s o leitor
# desistia antes de a ponte existir — trocava-se um stream seco por um
# handshake legítimo cortado. A detecção de "parou no meio" fica com o
# watchdog do Go (12s sem RTP), que é quem consegue reagir.
READ_TIMEOUT = float(__import__("os").environ.get("NEBULA_RTSP_READ_TIMEOUT", "25"))
# Prazo para o PRIMEIRO quadro de cada tentativa, checado dentro do laço.
FIRST_FRAME_DEADLINE = float(__import__("os").environ.get("NEBULA_RTSP_FIRST_FRAME", "40"))
BACKOFF_MAX = float(__import__("os").environ.get("NEBULA_RTSP_BACKOFF_MAX", "8"))


@dataclass
class StreamStatus:
    url: str = ""
    state: str = "idle"          # idle | connecting | live | error
    frames: int = 0
    last_frame_ts: float = 0.0
    first_frame_ts: float = 0.0
    fps: float = 0.0
    codec: str = ""
    size: str = ""
    error: str = ""
    error_kind: str = ""
    history: list = field(default_factory=list)

    # diagnóstico novo
    attempts: int = 0
    bytes_in: int = 0
    opened_ts: float = 0.0
    dry_for: float = 0.0          # segundos sem quadro
    connected_for: float = 0.0    # segundos da tentativa atual
    last_error_ts: float = 0.0
    probe_deadline: float = 0.0

    def snapshot(self) -> dict:
        now = time.time()
        dry = (now - self.last_frame_ts) if self.last_frame_ts else \
              (now - self.opened_ts if self.opened_ts else 0.0)
        return {
            "url": self.url,
            "state": self.state,
            "frames": self.frames,
            "fps": self.fps,
            "codec": self.codec,
            "size": self.size,
            "error": self.error,
            "error_kind": self.error_kind,
            "history": list(self.history[-5:]),
            "attempts": self.attempts,
            "bytes": self.bytes_in,
            "dry_for": round(dry, 2),
            "connected_for": round(now - self.opened_ts, 2) if self.opened_ts else 0.0,
            "first_frame_in": round(self.first_frame_ts - self.opened_ts, 2)
                              if (self.first_frame_ts and self.opened_ts) else None,
            "last_frame_age": round(now - self.last_frame_ts, 2) if self.last_frame_ts else None,
        }


class RtspMjpegBridge:
    """
    Le um RTSP e emite JPEG. Faz reconnection com backoff porque o
    tuya-ipc-terminal derruba a sessao quando a camera fecha o WebRTC.

    `on_event` recebe ("opened"|"frame"|"error"|"closed", status) e e o que o
    watchdog usa para distinguir "o leitor caiu" de "a ponte inteira morreu".
    """

    def __init__(self, url: str, width: int = 640, quality: int = 60,
                 max_fps: float = 12.0, max_retries: int = 0,
                 first_frame_deadline: float = FIRST_FRAME_DEADLINE,
                 read_timeout: float = READ_TIMEOUT,
                 on_event: Callable[[str, "StreamStatus"], None] | None = None):
        if av is None:
            raise RuntimeError(
                "PyAV ausente. Instale com: python3 -m pip install av"
            )
        self.url = url
        self.width = width
        self.quality = quality
        self.max_fps = max_fps
        self.max_retries = max_retries  # 0 = tenta para sempre
        self.first_frame_deadline = first_frame_deadline
        self.read_timeout = read_timeout
        self.on_event = on_event
        self.status = StreamStatus(url=url)
        self._stop = threading.Event()
        self._lock = threading.Lock()

    # -- interno ---------------------------------------------------------
    def _emit(self, kind: str) -> None:
        if not self.on_event:
            return
        try:
            self.on_event(kind, self.status)
        except Exception:
            pass

    def _note_error(self, msg: str, kind: str = "read") -> None:
        with self._lock:
            self.status.state = "error"
            self.status.error = msg[:300]
            self.status.error_kind = kind
            self.status.last_error_ts = time.time()
            self.status.history.append(f"{time.strftime('%H:%M:%S')} {msg[:160]}")
            del self.status.history[:-10]
        self._emit("error")

    def _open(self):
        self.status.state = "connecting"
        self.status.opened_ts = time.time()
        self.status.connected_for = 0.0
        # rtsp_transport=tcp: a cameras Tuya nao aceitam UDP de forma confiavel
        # atras do relay do tuya-ipc-terminal.
        #
        # Três prazos, porque são três camadas diferentes:
        #   container_options["timeout"] — opção do demuxer RTSP (socket TCP);
        #     é a que realmente interrompe um `decode()` sem bytes. Medido: sem
        #     ela o gerador passava de 26s preso mesmo com read_timeout=3.
        #   options["stimeout"]           — ms, legado do demuxer;
        #   timeout=(abrir, ler)          — I/O do PyAV (cobre o header).
        opts = {"rtsp_transport": "tcp",
                "stimeout": str(int(self.read_timeout * 1000))}
        copts = {"rtsp_transport": "tcp",
                 "timeout": str(max(1, int(self.read_timeout)))}
        container = av.open(self.url, options=opts, container_options=copts,
                            timeout=(OPEN_TIMEOUT, self.read_timeout))
        self.status.probe_deadline = time.time() + self.first_frame_deadline
        self._emit("opened")
        return container

    def stop(self) -> None:
        """Pede a parada do gerador na próxima iteração (usado no restart)."""
        self._stop.set()

    def frames_alive(self) -> bool:
        return (time.time() - self.status.last_frame_ts) < 3.0 and self.status.frames > 0

    # -- API -------------------------------------------------------------
    def jpeg_frames(self) -> Iterator[bytes]:
        """Gerador infinito de quadros JPEG. Reconecta sozinho."""
        from io import BytesIO
        from PIL import Image

        self._stop.clear()
        attempt = 0
        last_emit = 0.0
        fps_window: list[float] = []
        container = None  # <- antes, um erro no open() fazia NameError aqui

        while not self._stop.is_set() and \
                (self.max_retries == 0 or attempt <= self.max_retries):
            attempt += 1
            self.status.attempts = attempt
            try:
                container = self._open()
                stream = container.streams.video[0]
                stream.thread_type = "AUTO"
                self.status.codec = (stream.codec_context.name or "?")

                for frame in container.decode(stream):
                    if self._stop.is_set():
                        break
                    now = time.time()

                    # Stream registrado mas nenhuma imagem: cortamos por prazo.
                    # O read timeout do PyAV cobre "zero bytes"; isto cobre
                    # "bytes chegando, mas nada decodificável".
                    if self.status.frames == 0 and now > self.status.probe_deadline:
                        self._note_error(
                            f"stream seco: nenhum quadro em "
                            f"{int(self.first_frame_deadline)}s", "dry")
                        container.close()
                        container = None
                        break

                    if now - last_emit < 1.0 / self.max_fps:
                        continue

                    img = frame.to_image()
                    if img.width > self.width:
                        h = max(1, int(img.height * self.width / img.width))
                        img = img.resize((self.width, h), Image.BILINEAR)

                    buf = BytesIO()
                    img.save(buf, "JPEG", quality=self.quality)
                    jpg = buf.getvalue()

                    with self._lock:
                        if self.status.frames == 0:
                            self.status.first_frame_ts = now
                        self.status.state = "live"
                        self.status.frames += 1
                        self.status.bytes_in += len(jpg)
                        self.status.last_frame_ts = now
                        self.status.size = f"{img.width}x{img.height}"
                        self.status.error = ""
                        self.status.error_kind = ""
                    fps_window.append(now)
                    del fps_window[:-30]
                    if len(fps_window) > 1:
                        span = fps_window[-1] - fps_window[0]
                        self.status.fps = round(
                            (len(fps_window) - 1) / span, 2) if span > 0 else 0.0

                    last_emit = now
                    self._emit("frame")
                    yield jpg

                if self._stop.is_set():
                    break
                self._note_error("stream terminou (câmera fechou a sessão)", "eof")

            except GeneratorExit:
                raise
            except Exception as exc:  # noqa: BLE001 - reportar e tentar de novo
                self._note_error(f"{type(exc).__name__}: {exc}", _kind_of(exc))
            finally:
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
                container = None

            if self._stop.is_set():
                break
            if self.max_retries and attempt > self.max_retries:
                break
            # backoff exponencial com teto: nao martelar a camera, mas também
            # nao ficar 30s sem tentar depois de uma queda de Wi-Fi.
            delay = min(BACKOFF_MAX, 0.5 * (2 ** min(attempt - 1, 4)))
            if self._stop.wait(delay):
                break

        self.status.state = "idle"
        self._emit("closed")


def _kind_of(exc: Exception) -> str:
    """Nome estável pro erro. O watchdog decide por isto."""
    name = type(exc).__name__
    text = str(exc).lower()
    if "timeout" in name.lower() or "timed out" in text:
        return "timeout"
    if "invaliddata" in name.lower() or "invalid data" in text:
        return "invalid_data"
    if "connection" in text and ("refused" in text or "reset" in text):
        return "connection"
    if "404" in text or "not found" in text:
        return "not_found"
    return "error"


class MjpegStreamManager:
    """Mantem uma ponte viva por cliente e permite checar saude sem abrir stream."""

    def __init__(self) -> None:
        self._bridges: dict[str, RtspMjpegBridge] = {}
        self._lock = threading.Lock()

    def bridge(self, url: str, width: int = 640, quality: int = 60,
               on_event: Callable[[str, "StreamStatus"], None] | None = None) -> RtspMjpegBridge:
        key = f"{url}|{width}|{quality}"
        with self._lock:
            b = self._bridges.get(key)
            if b is None:
                b = RtspMjpegBridge(url, width=width, quality=quality, on_event=on_event)
                self._bridges[key] = b
            return b

    def drop(self, url: str) -> None:
        """Esquece (e para) a ponte de uma URL — usado quando o stream é
        reconstruído, para o próximo leitor não herdar estado velho."""
        with self._lock:
            victims = [b for k, b in self._bridges.items() if k.split("|", 1)[0] == url]
            for k, b in list(self._bridges.items()):
                if k.split("|", 1)[0] == url:
                    self._bridges.pop(k, None)
        for b in victims:
            try:
                b.stop()
            except Exception:
                pass

    def drop_all(self) -> None:
        with self._lock:
            bridges = list(self._bridges.values())
            self._bridges.clear()
        for b in bridges:
            try:
                b.stop()
            except Exception:
                pass

    def reset_status(self) -> None:
        """
        Zera a contabilidade sem parar os leitores.

        Usado quando o watchdog reinicia o PROCESSO da ponte: os sockets RTSP
        morrem sozinhos e o laço de reconexão do leitor já se recupera. Parar
        os geradores (o que `drop_all` faz) encerrava a resposta MJPEG em curso
        — o navegador veria o `<img>` quebrar a cada reinício, mesmo com a
        câmera de volta 2 segundos depois.
        """
        with self._lock:
            bridges = list(self._bridges.values())
        for b in bridges:
            with b._lock:
                b.status.frames = 0
                b.status.bytes_in = 0
                b.status.first_frame_ts = 0.0
                b.status.last_frame_ts = 0.0
                b.status.fps = 0.0
                b.status.state = "connecting"
                b.status.error = ""
                b.status.error_kind = ""

    def statuses(self) -> list[dict]:
        with self._lock:
            bridges = list(self._bridges.values())
        return [b.status.snapshot() for b in bridges]

    def readers(self) -> list[dict]:
        """Estado por URL (qualquer largura). É o que o watchdog consulta."""
        with self._lock:
            bridges = list(self._bridges.values())
        now = time.time()
        out = []
        for b in bridges:
            st = b.status
            last = st.last_frame_ts or 0.0
            out.append({
                "url": b.url,
                "state": st.state,
                "frames": st.frames,
                "attempts": st.attempts,
                "dry_for": round(now - last, 2) if last else
                           round(now - st.opened_ts, 2) if st.opened_ts else 0.0,
                "opened_for": round(now - st.opened_ts, 2) if st.opened_ts else 0.0,
                "error": st.error,
                "error_kind": st.error_kind,
                "codec": st.codec,
                "size": st.size,
                "fps": st.fps,
                "last_error_age": round(now - st.last_error_ts, 2) if st.last_error_ts else None,
            })
        return out

    def probe(self, url: str, timeout: float = 12.0,
              frame_timeout: float = 30.0, attempts: int = 2) -> dict:
        """
        Abre o RTSP uma vez, le um unico quadro e fecha. Serve para
        'o stream existe?' sem deixar sessao pendurada.

        `frame_timeout` é generoso de propósito: abrir o stream DESPERTA a
        ponte (o Go só negocia WebRTC quando há cliente), e esse handshake leva
        ~14s medidos na SMBC1BS1. Com o read timeout curto, o botão "Testar"
        falharia sempre em cima de uma câmera sadia.

        Duas tentativas: a primeira pode pegar o stream no meio de um GOP (a
        câmera não reenvia SPS/PPS nesse caso) e produzir InvalidDataError com
        a câmera perfeitamente viva — uma sondagem deve provar que o stream
        existe, não ser loteria.
        """
        if av is None:
            return {"ok": False, "error": "PyAV ausente"}
        last: dict = {}
        for n in range(max(1, attempts)):
            out = self._probe_once(url, timeout, frame_timeout)
            out["attempts"] = n + 1
            if out.get("ok"):
                return out
            last = out
            time.sleep(1.5)
        return last

    def _probe_once(self, url: str, timeout: float, frame_timeout: float) -> dict:
        out: dict = {"url": url, "ok": False, "t0": time.time()}
        container = None
        opened = False
        try:
            container = av.open(url,
                                options={"rtsp_transport": "tcp",
                                         "stimeout": str(int(frame_timeout * 1000))},
                                container_options={"rtsp_transport": "tcp",
                                                   "timeout": str(int(frame_timeout))},
                                timeout=(min(timeout, 10.0), frame_timeout))
            opened = True
            stream = container.streams.video[0]
            for frame in container.decode(stream):
                out.update(
                    ok=True,
                    codec=stream.codec_context.name,
                    size=f"{frame.width}x{frame.height}",
                    pix_fmt=str(frame.format),
                    first_frame_in=round(time.time() - out["t0"], 2),
                )
                break
            else:
                # Abriu e não decodificou. Cliente que entra no MEIO de um GOP
                # não recebe SPS/PPS e o ffmpeg responde "no frame!" — o stream
                # está vivo, é a sondagem que não tem onde começar.
                out["error"] = ("stream aberto, mas este cliente não recebeu "
                                "SPS/PPS (entrou no meio de um GOP)")
                out["error_kind"] = "no_parameters"
                out["hint"] = ("abra 'Ver ao vivo' para aquecer o stream; o "
                               "preview MJPEG decodifica normalmente")
        except Exception as exc:  # noqa: BLE001
            out["error"] = f"{type(exc).__name__}: {exc}"[:300]
            out["error_kind"] = _kind_of(exc)
            out["opened"] = opened
        finally:
            if container is not None:
                try:
                    container.close()
                except Exception:
                    pass
        if not out.get("ok") and "error" not in out:
            out["error"] = "nenhum quadro de video no stream"
            out["error_kind"] = "empty"
        return out


MANAGER = MjpegStreamManager()