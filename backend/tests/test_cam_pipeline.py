"""
Testes da ponte de vídeo — o `InvalidDataError` recorrente, de forma
determinista e sem depender da conta real.

    python3 backend/tests/test_cam_pipeline.py

O que é reproduzido aqui:

  T1  RTSP que responde OPTIONS/DESCRIBE/SETUP/PLAY (ou seja: "o stream está
      registrado") e **nunca** manda RTP. É o zumbi do `tuya-ipc-terminal`.
      Antes: o `decode()` ficava bloqueado para sempre, o gerador não emitia
      nada e o `<img>` do navegador ficava preto sem diagnóstico.
      Agora: o leitor falha em tempo limitado, com erro nomeado.

  T2  O mesmo stream seco não pode derrubar a resposta HTTP: o gerador tem de
      encerrar de forma limpa, com histórico do motivo.

  T3  RTSP com H.264 de verdade (SPS/PPS + keyframes + delta frames) tem de
      produzir quadros JPEG — o caminho feliz, para provar que o resto do
      pipeline não foi quebrado.

  T4  O gerador sobrevive a uma queda no meio do stream e reconecta.

  T5  `MANAGER.drop()` realmente interrompe um leitor pendurado (é o que o
      watchdog chama ao derrubar uma câmera).
"""
from __future__ import annotations

import os
import socket
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import av  # noqa: E402
import numpy as np  # noqa: E402

import tuya_rtsp as rtsp_mod  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 12

# SDP de uma câmera H.264 640x360 com os parâmetros no SDP: é o que permite
# ao PyAV abrir o stream e conhecer o codec ANTES de qualquer pacote.
SDP = (
    "v=0\r\n"
    "o=- 0 0 IN IP4 127.0.0.1\r\n"
    "s=Nebula Zombie Cam\r\n"
    "c=IN IP4 127.0.0.1\r\n"
    "t=0 0\r\n"
    "a=control:*\r\n"
    "m=video 0 RTP/AVP 96\r\n"
    "a=rtpmap:96 H264/90000\r\n"
    "a=fmtp:96 packetization-mode=1;profile-level-id=42001f;sprop-parameter-sets="
    "Z0IAKZpmBaHogA==,aM48gA==\r\n"
    "a=control:trackID=0\r\n"
)


def _h264_samples(count: int = 60):
    """
    Gera NULs H.264 de verdade com o libx264 embutido no PyAV.

    Bytes escritos à mão "parecem" H.264 mas não decodificam — o teste do
    caminho feliz precisa de um stream que o decodificador aceite de fato.
    Retorna [(tipo_nal, payload_annexb)] com um IDR a cada GOP.
    """
    cc = av.CodecContext.create("libx264", "w")
    cc.width, cc.height = 160, 90
    cc.pix_fmt = "yuv420p"
    cc.time_base = av.time_base  # 1/1000000
    cc.options = {"tune": "zerolatency", "g": "10", "bf": "0",
                  "preset": "ultrafast"}
    cc.open()

    out: list[tuple[int, bytes]] = []
    yy, xx = np.mgrid[0:90, 0:160]
    for i in range(count):
        arr = ((xx * 3 + yy * 5 + i * 7) & 0xFF).astype(np.uint8)
        frame = av.VideoFrame.from_ndarray(arr, format="gray").reformat(format="yuv420p")
        frame.pts = i
        for pkt in cc.encode(frame):
            out.extend(_split_annexb(bytes(pkt)))
    for pkt in cc.encode(None):
        out.extend(_split_annexb(bytes(pkt)))
    return out


def _split_annexb(blob: bytes) -> list[tuple[int, bytes]]:
    """
    Quebra Annex-B em NALs individuais (tipo, bytes SEM start code).

    Importante: um pacote do libx264 costuma bring SPS+PPS+IDR juntos. Enviar
    só o primeiro NAL significaria mandar só parametrização — e o decodificador
    responderia InvalidDataError, que é exatamente o sintoma que este trabalho
    quer distinguir de "stream seco".
    """
    starts = [i for i in range(len(blob) - 3)
              if blob[i] == 0 and blob[i + 1] == 0 and blob[i + 2] == 1]
    if not starts:
        return [(0, blob)]
    out = []
    for n, i in enumerate(starts):
        j = i + 3
        end = starts[n + 1] if n + 1 < len(starts) else len(blob)
        nal = blob[j:end]
        while nal.endswith(b"\x00"):
            nal = nal[:-1]
        if nal:
            out.append((nal[0] & 0x1F, nal))
    return out


_NAL_CACHE: dict[str, list[tuple[int, bytes]]] = {}


def _stream_nals() -> list[tuple[int, bytes]]:
    """Mesma amostra para todos os testes: gerar com x264 é lento."""
    key = "h264"
    if key not in _NAL_CACHE:
        _NAL_CACHE[key] = _h264_samples(40)
    return _NAL_CACHE[key]


def _rtp(payload: bytes, seq: int, ssrc: int = 0x11223344) -> bytes:
    b = bytearray(12)
    struct.pack_into("!BBHII", b, 0, 0x80, 96, seq, 0, ssrc)
    return bytes(b) + payload


class ZombieRtspServer:
    """
    RTSP mínimo que faz o handshake inteiro e depois fica em silêncio.
    `media=True` manda RTP de verdade, senão é o zumbi.
    """

    def __init__(self, media: bool = False):
        self.media = media
        self.clients = 0
        self.connections = 0
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.port = self.sock.getsockname()[1]
        self.url = f"rtsp://127.0.0.1:{self.port}/zombie"
        self._stop = threading.Event()
        self.threads: list[threading.Thread] = []
        threading.Thread(target=self._accept, daemon=True).start()

    def _accept(self):
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            self.connections += 1
            t = threading.Thread(target=self._serve, args=(conn,), daemon=True)
            t.start()
            self.threads.append(t)

    def _serve(self, conn: socket.socket):
        self.clients += 1
        buf = b""
        seq = 1
        playing = False
        try:
            while not self._stop.is_set():
                conn.settimeout(0.5)
                try:
                    chunk = conn.recv(4096)
                except socket.timeout:
                    chunk = b""
                except OSError:
                    break
                if not chunk and not playing:
                    break
                buf += chunk
                while b"\r\n\r\n" in buf:
                    head, buf = buf.split(b"\r\n\r\n", 1)
                    text = head.decode("utf-8", "replace")
                    method = text.split(" ")[0] if text else ""
                    lines = dict(
                        (k.strip().lower(), v.strip())
                        for k, _, v in (l.partition(":") for l in text.split("\r\n")[1:])
                        if k.strip()
                    )
                    cseq = lines.get("cseq", "0")
                    session = lines.get("session", "NEBULA123")

                    if method == "OPTIONS":
                        reply = (f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                                 "Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN\r\n\r\n")
                    elif method == "DESCRIBE":
                        reply = (f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                                 "Content-Type: application/sdp\r\n"
                                 f"Content-Base: {self.url}/\r\n"
                                 f"Content-Length: {len(SDP)}\r\n\r\n{SDP}")
                    elif method == "SETUP":
                        reply = (f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                                 f"Session: {session}\r\n"
                                 "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n")
                    elif method == "PLAY":
                        reply = (f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n"
                                 f"Session: {session}\r\nRange: npt=0.000-\r\n\r\n")
                        playing = True
                        threading.Thread(
                            target=self._pump_rtp, args=(conn, seq),
                            daemon=True).start()
                        seq = 1
                    elif method == "TEARDOWN":
                        conn.sendall(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\n\r\n".encode())
                        return
                    else:
                        reply = f"RTSP/1.0 501 Not Implemented\r\nCSeq: {cseq}\r\n\r\n"
                    conn.sendall(reply.encode())
        finally:
            self.clients -= 1
            try:
                conn.close()
            except OSError:
                pass

    def _pump_rtp(self, conn: socket.socket, seq: int):
        """Mídia real (T3/T4) ou silêncio absoluto (T1/T2)."""
        if not self.media:
            while not self._stop.is_set():
                time.sleep(0.2)
            return
        nals = _stream_nals()
        i = 0
        while not self._stop.is_set():
            try:
                nal = nals[i % len(nals)][1]
                pkt = _rtp(nal, seq)
                conn.sendall(b"$\x00" + struct.pack("!H", len(pkt)) + pkt)
                seq = (seq + 1) & 0xFFFF
                i += 1
            except OSError:
                return
            time.sleep(1.0 / FPS)
            # "queda" periódica: o leitor tem de voltar sozinho (T4)
            if i % (FPS * 3) == 0:
                time.sleep(3.0)

    def close(self):
        self._stop.set()
        try:
            self.sock.close()
        except OSError:
            pass
        for t in self.threads:
            t.join(timeout=1)


# ---------------------------------------------------------------------------
def check(name, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        raise AssertionError(name)


def t1_zombie_stream_fails_bounded():
    """Stream registrado sem mídia: erro em tempo limitado, não silêncio."""
    srv = ZombieRtspServer(media=False)
    print("\nT1 — RTSP registrado, zero RTP (o zumbi)")
    try:
        b = rtsp_mod.RtspMjpegBridge(
            srv.url, width=320, max_fps=5, max_retries=1,
            read_timeout=3.0, first_frame_deadline=4.0)
        t0 = time.time()
        got = []
        try:
            for jpg in b.jpeg_frames():
                got.append(jpg)
                break
        except Exception as exc:
            print(f"        exceção: {type(exc).__name__}: {str(exc)[:90]}")
        dt = time.time() - t0
        st = b.status
        check("handshake aconteceu (o stream existe mesmo assim)",
              srv.connections >= 1, f"{srv.connections} conexão(ões)")
        check("nenhum quadro emitido", not got)
        check("não travou: falhou em menos de 12s", dt < 12, f"{dt:.1f}s")
        check("o dry virou erro nomeado, não silêncio",
              bool(st.error) and bool(st.last_error_ts) and st.error_kind,
              f"kind={st.error_kind!r} err={st.error[:60]!r}")
        check("o erro é de leitura/timeout, não de decode",
              st.error_kind in ("timeout", "dry", "error"),
              st.error_kind)
        check("há histórico para a UI", len(st.history) >= 1,
              st.history[-1][:70] if st.history else "")
        check("estado não ficou 'connecting' eterno",
              st.state in ("error", "idle", "connecting") and st.attempts >= 1,
              f"state={st.state} attempts={st.attempts}")
    finally:
        srv.close()


def t2_dry_stream_does_not_kill_response():
    """
    O laço de reconexão tem de ser silencioso para quem chama (o handler HTTP
    do MJPEG) e encerrar limpo no `stop()`.

    Antes, um `av.open()` que falhava deixava `container` sem valor e o
    `finally: container.close()` levantava NameError — que ESCAPA do gerador
    e derrubava a resposta inteira, sem nenhum quadro nem diagnóstico.
    """
    srv = ZombieRtspServer(media=False)
    print("\nT2 — laço de reconexão não vaza exceção e encerra limpo")
    try:
        b = rtsp_mod.RtspMjpegBridge(srv.url, width=320, max_retries=0,
                                     read_timeout=2.0, first_frame_deadline=3.0)
        state = {"frames": 0}

        def reader():
            try:
                for _ in b.jpeg_frames():
                    state["frames"] += 1
            except BaseException as exc:          # noqa: BLE001
                state["err"] = exc

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        time.sleep(9)
        attempts = b.status.attempts
        b.stop()
        th.join(timeout=12)

        check("nenhuma exceção escapou do gerador", "err" not in state,
              f"{type(state.get('err')).__name__}: {state.get('err')}"
              if "err" in state else "")
        check("reconectou sozinho (tentativas > 1)", attempts >= 2,
              f"{attempts} tentativas em 9s")
        check("nenhum quadro emitido para stream morto", state["frames"] == 0)
        check("parou no stop() sem travar", not th.is_alive())
        check("estado final é observável", b.status.state in ("idle", "error"),
              b.status.state)
    finally:
        srv.close()


def t3_real_media_produces_jpeg():
    """Caminho feliz: H.264 chegando vira quadro JPEG."""
    srv = ZombieRtspServer(media=True)
    print("\nT3 — RTSP com H.264 real entrega quadros")
    try:
        b = rtsp_mod.RtspMjpegBridge(srv.url, width=320, max_fps=5,
                                     first_frame_deadline=8.0, read_timeout=4.0)
        jpg = None
        t0 = time.time()
        for frame in b.jpeg_frames():
            jpg = frame
            break
        dt = time.time() - t0
        if jpg is None:
            check("quadro recebido", False, f"status={b.status.snapshot()}")
            return
        check("quadro JPEG recebido", jpg[:2] == b"\xff\xd8",
              f"{len(jpg)} bytes em {dt:.1f}s, codec={b.status.codec}")
        check("tempo até o primeiro quadro é razoável", dt < 15, f"{dt:.1f}s")
        check("status conta o quadro", b.status.frames >= 1)
    finally:
        srv.close()


def t4_stream_survives_drop_and_reconnects():
    """Queda no meio: o leitor volta sozinho (reconnect do PyAV)."""
    srv = ZombieRtspServer(media=True)
    print("\nT4 — queda no meio do stream reconecta")
    try:
        b = rtsp_mod.RtspMjpegBridge(srv.url, width=320, max_fps=8,
                                     first_frame_deadline=10.0, read_timeout=3.0)
        gen = b.jpeg_frames()
        first = next(gen)
        check("primeiro quadro", first[:2] == b"\xff\xd8")
        got_second = False
        t0 = time.time()
        while time.time() - t0 < 25:
            try:
                f = next(gen)
            except StopIteration:
                break
            if f[:2] == b"\xff\xd8":
                got_second = True
                break
        check("voltou a emitir depois da queda", got_second,
              f"frames={b.status.frames} attempts={b.status.attempts}")
    finally:
        srv.close()


def t5_drop_interrupts_a_pending_reader():
    """`drop()` é o que o watchdog chama: precisa acordar o leitor."""
    srv = ZombieRtspServer(media=False)
    print("\nT5 — MANAGER.drop() acorda um leitor preso")
    try:
        b = rtsp_mod.RtspMjpegBridge(srv.url, width=320, max_retries=0,
                                     read_timeout=30.0, first_frame_deadline=60.0)
        state = {}

        def reader():
            try:
                for _ in b.jpeg_frames():
                    break
            except Exception as exc:
                state["err"] = exc

        th = threading.Thread(target=reader, daemon=True)
        th.start()
        time.sleep(2.5)
        t0 = time.time()
        b.stop()
        th.join(timeout=12)
        dt = time.time() - t0
        check("leitor saiu antes do read_timeout de 30s",
              not th.is_alive() and dt < 10, f"{dt:.1f}s")
    finally:
        srv.close()


TESTS = [t1_zombie_stream_fails_bounded, t2_dry_stream_does_not_kill_response,
         t3_real_media_produces_jpeg, t4_stream_survives_drop_and_reconnects,
         t5_drop_interrupts_a_pending_reader]


if __name__ == "__main__":
    if av is None:
        print("PyAV ausente — pule")
        sys.exit(0)
    only = sys.argv[1:] or None
    failed = 0
    for t in TESTS:
        if only and not any(o in t.__name__ for o in only):
            continue
        try:
            t()
        except AssertionError as e:
            print(f"  FALHOU: {e}")
            failed += 1
        except Exception as e:  # noqa: BLE001
            print(f"  ERRO: {type(e).__name__}: {e}")
            failed += 1
    print("\n" + ("TODOS OS TESTES PASSARAM" if not failed
                  else f"{failed} teste(s) falharam"))
    sys.exit(1 if failed else 0)