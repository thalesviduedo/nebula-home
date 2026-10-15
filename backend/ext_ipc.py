"""
Capacidades da camera IPC + central de mensagens, lidas no gateway movel.

Tudo aqui foi testado AO VIVO contra a conta real (ver
/tmp/ext-ipc-probe.json). O que ENTRA no codigo — porque respondeu:

    caps      m.ipc.v4.rtc.config.get                  v1.0  {devId,gwId}
              m.ipc.smart.image.quality.support.query  v1.0  {devId,gwId} -> false
              m.ipc.twoway.call.ability.get            v1.0  {devId,gwId} -> {enable:false}
              smartlife.m.ipc.ap.status                v1.0  {devId,gwId} -> {businessResult:false}
              smartlife.m.ipc.ui.config.get            v1.0  {devId,gwId} -> {1,1}
    messages  smartlife.m.msg.new                      v1.0  {} -> {alarm,family,notification}
              smartlife.m.msg.notice.switch.status     v1.0  {"type": int 1..6}
    notices   smartlife.m.notice.new.get               v1.0  {} -> true
              m.message.device.alarm.nodisturb.list    v3.0  {} -> [] (so v3.0!)

O que foi testado e NAO ENTRA (endpoint morto nao vai para o caminho quente):

    m.ipc.camera.cover.get            v1.0 REMOTE_API_PARAM_ALL_INPUT_LOSS;
                                      v2.0+ API_OR_API_VERSION_WRONG
    m.ipc.service.entrance.status     v1.0/v2.0 REMOTE_API_PARAM_ALL_INPUT_LOSS
    m.ipc.protect.card.data.get       v1.0 REMOTE_API_PARAM_ALL_INPUT_LOSS;
                                      v2.0 API_OR_API_VERSION_WRONG
    m.life.app.p2p.main.pre.link.get  v1.0-v4.0 API_OR_API_VERSION_WRONG
    smartlife.m.app.dynamic.config.get v1.0-v4.0 API_OR_API_VERSION_WRONG

Pegadinhas que a sondagem ensinou (nao redescubrir):
  * gwId vazio da IS_BLANK/gwIdBlank: todo payload de camera manda
    gwId = devId, sempre como STRING (int da REMOTE_API_PARAM_ALL_INPUT_LOSS).
  * switch.status com payload vazio da REMOTE_API_PARAM_ALL_INPUT_LOSS; com
    type string da PARAMS_ILLEGAL_OR_DATA_ILLEGAL; o que ele quer e type
    INTEIRO de 1 a 6 — ai devolve o booleano da categoria.
  * nodisturb.list so existe na v3.0; em 1.0/2.x/3.1+ da API_OR_API_VERSION_WRONG.

Segredo: m.ipc.v4.rtc.config.get devolve a sessao P2P inteira — auth,
password, motoId, p2pConfig.session (aesKey, icePassword, iceUfrag,
sessionId, traceId), p2pConfig.log (contem tcp.key), tcpRelay.credential e
ices[].credential. NADA disso sai daqui: _rtc_public() reconstrui o dict do
zero por allow-list. O navegador recebe so capacidade (streams/codecs/
resolucoes) e host:port de infraestrutura (STUN/TURN/relay), o mesmo nivel
que /api/config ja expoe em `p2p`.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import tuya_mobile as tm

SLUG = "ipc"

# --- rotas que funcionam (acao, versao) -------------------------------------
API_RTC = "m.ipc.v4.rtc.config.get"                        # v1.0
API_IMAGE_QUALITY = "m.ipc.smart.image.quality.support.query"  # v1.0
API_TWOWAY = "m.ipc.twoway.call.ability.get"               # v1.0
API_AP_STATUS = "smartlife.m.ipc.ap.status"                # v1.0
API_UI_CONFIG = "smartlife.m.ipc.ui.config.get"            # v1.0

API_MSG_NEW = "smartlife.m.msg.new"                        # v1.0, {}
API_MSG_SWITCH = "smartlife.m.msg.notice.switch.status"    # v1.0, {"type": int}
API_NOTICE_NEW = "smartlife.m.notice.new.get"              # v1.0, {}
API_NODISTURB = "m.message.device.alarm.nodisturb.list"   # v3.0, {}

# categorias de push que switch.status conhece (type inteiro 1..6)
SWITCH_TYPES = (1, 2, 3, 4, 5, 6)

TIMEOUT = 12

_CACHE: dict[str, tuple[float, Any]] = {}
_CACHE_LOCK = threading.Lock()
CACHE_TTL = 30.0


def _sess(bundle):
    return tm.session_from_cloud((bundle or {}).get("cloud") or {})


# --- transporte --------------------------------------------------------------
def _call(action: str, payload: dict, sid: str, ecode: str, url: str,
          version: str = "1.0") -> tuple[Any, str]:
    """(resultado, erro). Nunca levanta: erro do gateway vira string."""
    try:
        result = tm.call(action, payload, sid=sid, ecode=ecode, endpoint=url,
                         version=version, timeout=TIMEOUT)
    except tm.GatewayError as exc:
        return None, str(exc)[:200]
    except Exception as exc:  # noqa: BLE001 - rede/DNS/qualquer coisa
        return None, f"{type(exc).__name__}: {exc}"[:200]
    if isinstance(result, dict) and (result.get("success") is False
                                     or result.get("errorCode")):
        code = result.get("errorCode") or "ERRO"
        return None, f"{code} {result.get('errorMsg') or ''}".strip()[:200]
    return result, ""


def _result_of(result: Any) -> Any:
    """Quase toda API embrulha a carga em `result`."""
    if isinstance(result, dict) and "result" in result:
        return result["result"]
    return result


def _cached(key: str) -> Any | None:
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_TTL:
        return hit[1]
    return None


def _store(key: str, value: Any) -> None:
    with _CACHE_LOCK:
        _CACHE[key] = (time.monotonic(), value)


# --- camera ------------------------------------------------------------------
def _find_camera(bundle: dict, sid: str, ecode: str, url: str) -> tuple[str, str]:
    """(deviceId, nome) da camera IPC: bundle kind=cam, senao skills.p2pType."""
    keys = (bundle or {}).get("keys") or {}
    for dev_id, entry in keys.items():
        if isinstance(entry, dict) and entry.get("kind") == "cam":
            return str(dev_id), str(entry.get("name") or dev_id)
    result, _err = _call(tm.API_HOME_LIST, {}, sid, ecode, url)
    for gid in tm._home_ids(result) if result is not None else []:
        found, _err = _call(tm.API_DEVICE_LIST, {"gid": gid}, sid, ecode, url,
                            version="2.2")  # device.list so responde v2.2
        if found is None:
            continue
        for node in tm._walk(found):
            dev_id = str(node.get("devId") or "")
            if not dev_id:
                continue
            skills = node.get("skills")
            if isinstance(skills, str):
                try:
                    skills = json.loads(skills)
                except (ValueError, TypeError):
                    skills = {}
            if isinstance(skills, dict) and skills.get("p2pType") is not None:
                return dev_id, str(node.get("name") or dev_id)
    return "", ""


def _host_of(url: str) -> str:
    """`turn:15.204.72.235:3478?transport=udp` -> `15.204.72.235:3478`."""
    raw = str(url or "").split("?")[0]
    if "://" in raw:
        raw = raw.split("://", 1)[1]
    return raw.rsplit(":", 1)[0] + ":" + raw.rsplit(":", 1)[-1] if ":" in raw else raw


def _codec_name(codec_type: Any) -> str:
    return {0: "unknown", 1: "H.264", 2: "H.264", 3: "H.265",
            101: "G.711 µ-law", 102: "G.711 A-law"}.get(codec_type, f"codec {codec_type}")


def _rtc_public(raw: Any) -> dict:
    """Allow-list: reconstrui do zero; a resposta crua (com credencial) morre aqui."""
    cfg = raw if isinstance(raw, dict) else {}
    p2p = cfg.get("p2pConfig") if isinstance(cfg.get("p2pConfig"), dict) else {}
    try:
        skill = json.loads(cfg["skill"]) if isinstance(cfg.get("skill"), str) else {}
    except (ValueError, TypeError):
        skill = {}
    if not isinstance(skill, dict):
        skill = {}

    videos = []
    for v in skill.get("videos") or []:
        if not isinstance(v, dict):
            continue
        videos.append({
            "stream_type": v.get("streamType"),
            "codec_type": v.get("codecType"),
            "codec": _codec_name(v.get("codecType")),
            "width": v.get("width"),
            "height": v.get("height"),
            "sample_rate": v.get("sampleRate"),
            "size": f"{v.get('width')}x{v.get('height')}" if v.get("width") else "",
        })
    audios = []
    for a in skill.get("audios") or []:
        if not isinstance(a, dict):
            continue
        audios.append({
            "codec_type": a.get("codecType"),
            "codec": _codec_name(a.get("codecType")),
            "sample_rate": a.get("sampleRate"),
            "channels": a.get("channels"),
        })

    ice_hosts = [ _host_of(str(ice["urls"]))
        for ice in p2p.get("ices") or []
        if isinstance(ice, dict) and ice.get("urls") ]
    relay = p2p.get("tcpRelay") if isinstance(p2p.get("tcpRelay"), dict) else {}
    relay_urls = [_host_of(str(u)) for u in (relay.get("urls") or []) if u]
    audio_attrs = cfg.get("audioAttributes") if isinstance(
        cfg.get("audioAttributes"), dict) else {}

    return {
        "id": cfg.get("id") or "",
        "p2p_type": cfg.get("p2pType"),
        "p2p_specified_type": cfg.get("p2pSpecifiedType"),
        "p2p_policy": cfg.get("p2pPolicy"),
        "is_cloud_p2p": bool(cfg.get("isCloudP2P")),
        "is_low_power": bool(cfg.get("isLowPower")),
        "is_4g_device": bool(cfg.get("is4GDevice")),
        "supports_webrtc": bool(cfg.get("supportsWebrtc")),
        "supports_webrtc_record": bool(cfg.get("supportWebrtcRecord")),
        "upgrade_relay": bool(cfg.get("upgradeRelay")),
        "preconnect": bool(p2p.get("preconnect")),
        "max_zoom_in_times": cfg.get("maxZoomInTimes"),
        "video_clarity": cfg.get("vedioClarity"),
        "video_clarities": cfg.get("vedioClaritys") or [],
        "transmission": str(p2p.get("transmission") or ""),
        "skill": {
            "sdk_version": skill.get("sdk_version"),
            "webrtc": skill.get("webrtc"),
            "p2p": skill.get("p2p"),
            "cloud_gw": skill.get("cloudGW"),
            "cloud_storage": skill.get("cloudStorage"),
            "video_num": skill.get("video_num"),
        },
        "videos": videos,
        "audios": audios,
        "audio_attributes": {
            "call_modes": audio_attrs.get("callMode") or [],
            "hardware_capability": audio_attrs.get("hardwareCapability") or [],
        },
        "ice_hosts": ice_hosts,
        "relay_urls": relay_urls,
        "redacted": ["auth", "password", "motoId", "p2pConfig.session",
                     "p2pConfig.auth", "p2pConfig.log", "tcpRelay.credential",
                     "ices[].credential"],
    }


# --- acao: caps --------------------------------------------------------------
def _caps(bundle: dict, dev_id: str) -> tuple[int, dict]:
    cloud = (bundle or {}).get("cloud") or {}
    if not cloud.get("accessToken"):
        return 401, {"error": "sem sessão no bundle: entre na conta primeiro"}
    uid = str(cloud.get("uid") or "")
    cached = _cached(f"caps|{uid}|{dev_id}")
    if cached is not None:
        return 200, {**cached, "cached": True}

    sid, ecode, url = _sess(bundle)
    if not ecode:
        return 401, {"error": "sem accessToken no bundle: refaça o login"}

    errors: dict[str, str] = {}
    found, name = (dev_id, "") if dev_id else _find_camera(bundle, sid, ecode, url)
    if not found:
        return 404, {"error": "nenhuma câmera IPC nesta conta",
                     "sources": {API_RTC: "sem device com p2pType"}}

    def call(key, action, payload, version="1.0"):
        result, err = _call(action, payload, sid, ecode, url, version)
        if err:
            errors[key] = err
        return result

    ident = {"devId": found, "gwId": found}  # gwId vazio = IS_BLANK; int = INPUT_LOSS
    rtc = _result_of(call("rtc", API_RTC, ident))
    quality = _result_of(call("image_quality", API_IMAGE_QUALITY, ident))
    twoway = _result_of(call("two_way", API_TWOWAY, ident))
    ap = _result_of(call("ap", API_AP_STATUS, ident))
    ui = _result_of(call("ui", API_UI_CONFIG, ident))

    data = {
        "device": {"id": found, "name": name or found},
        "p2p": _rtc_public(rtc),
        "smart_image_quality": bool(quality) if quality is not None else None,
        "two_way": {"enable": bool((twoway or {}).get("enable"))} if twoway is not None else None,
        "ap": {"business_result": (ap or {}).get("businessResult")} if ap is not None else None,
        "ui": {"setting_panel_version": (ui or {}).get("settingPanelVersion"),
               "setting_theme": (ui or {}).get("settingTheme")} if ui is not None else None,
        "sources": {
            API_RTC: "ok" if rtc is not None else "erro",
            API_IMAGE_QUALITY: "ok" if quality is not None else "erro",
            API_TWOWAY: "ok" if twoway is not None else "erro",
            API_AP_STATUS: "ok" if ap is not None else "erro",
            API_UI_CONFIG: "ok" if ui is not None else "erro",
        },
        "errors": errors,
        "cached": False,
    }
    _store(f"caps|{uid}|{found}", data)
    return 200, data


# --- acao: messages ----------------------------------------------------------
def _messages(bundle: dict) -> tuple[int, dict]:
    cloud = (bundle or {}).get("cloud") or {}
    if not cloud.get("accessToken"):
        return 401, {"error": "sem sessão no bundle: entre na conta primeiro"}
    uid = str(cloud.get("uid") or "")
    cached = _cached(f"msg|{uid}")
    if cached is not None:
        return 200, {**cached, "cached": True}

    sid, ecode, url = _sess(bundle)
    if not ecode:
        return 401, {"error": "sem accessToken no bundle: refaça o login"}

    errors: dict[str, str] = {}
    new = _call(API_MSG_NEW, {}, sid, ecode, url)[0]
    if new is None:
        errors[API_MSG_NEW] = "indisponível"
    unread_raw = _result_of(new) if new is not None else None
    unread_raw = unread_raw if isinstance(unread_raw, dict) else {}

    switches: list[dict] = []
    for t in SWITCH_TYPES:
        result, err = _call(API_MSG_SWITCH, {"type": t}, sid, ecode, url)
        if err:
            errors[f"{API_MSG_SWITCH}#type={t}"] = err
            continue
        switches.append({"type": t, "on": bool(_result_of(result))})

    data = {
        "unread": {k: bool(unread_raw.get(k)) for k in
                   ("alarm", "family", "notification")},
        "unread_count": sum(1 for v in unread_raw.values() if v is True),
        "switches": switches,
        "switches_on": sum(1 for s in switches if s["on"]),
        "sources": {
            API_MSG_NEW: "ok" if new is not None else "erro",
            API_MSG_SWITCH: "ok" if switches else "erro",
        },
        "errors": errors,
        "cached": False,
    }
    _store(f"msg|{uid}", data)
    return 200, data


# --- acao: notices -----------------------------------------------------------
def _notices(bundle: dict) -> tuple[int, dict]:
    cloud = (bundle or {}).get("cloud") or {}
    if not cloud.get("accessToken"):
        return 401, {"error": "sem sessão no bundle: entre na conta primeiro"}
    uid = str(cloud.get("uid") or "")
    cached = _cached(f"notices|{uid}")
    if cached is not None:
        return 200, {**cached, "cached": True}

    sid, ecode, url = _sess(bundle)
    if not ecode:
        return 401, {"error": "sem accessToken no bundle: refaça o login"}

    errors: dict[str, str] = {}
    new_notice = _call(API_NOTICE_NEW, {}, sid, ecode, url)[0]
    if new_notice is None:
        errors[API_NOTICE_NEW] = "indisponível"

    nd_raw, nd_err = _call(API_NODISTURB, {}, sid, ecode, url, version="3.0")
    if nd_err:
        errors[API_NODISTURB] = nd_err
    raw_list = _result_of(nd_raw) if nd_raw is not None else []
    if not isinstance(raw_list, list):
        raw_list = []

    known = {d: (e.get("name") or d)
             for d, e in ((bundle.get("keys") or {}).items())
             if isinstance(e, dict)}
    nodisturb = []
    for node in raw_list:
        if not isinstance(node, dict):
            continue
        dev_id = str(node.get("devId") or node.get("id") or "")
        if not dev_id:
            continue
        nodisturb.append({
            "id": dev_id,
            "name": known.get(dev_id) or str(node.get("name") or dev_id),
            "enabled": bool(node.get("enable", node.get("status"))),
            "switch": node.get("switch"),
            "effect": node.get("effect"),
            "time_range": node.get("timeRange") or node.get("time"),
        })

    data = {
        "new_notice": bool(_result_of(new_notice)) if new_notice is not None else None,
        "nodisturb": nodisturb,
        "nodisturb_count": len(nodisturb),
        "sources": {
            API_NOTICE_NEW: "ok" if new_notice is not None else "erro",
            API_NODISTURB: "ok" if not nd_err else "erro",
        },
        "errors": errors,
        "cached": False,
    }
    _store(f"notices|{uid}", data)
    return 200, data


# --- contrato ----------------------------------------------------------------
def handle(action: str, query: dict, body: dict, bundle: dict) -> tuple[int, dict]:
    """Roteia a acao. Nunca deixa excecao escapar para o servidor."""
    try:
        action = str(action or "").strip().lower()
        query = query if isinstance(query, dict) else {}
        body = body if isinstance(body, dict) else {}
        bundle = bundle if isinstance(bundle, dict) else {}

        if action == "caps":
            dev_id = str(query.get("id") or query.get("devId")
                         or body.get("id") or body.get("devId") or "")
            return _caps(bundle, dev_id)
        if action == "messages":
            return _messages(bundle)
        if action == "notices":
            return _notices(bundle)
        return 400, {"error": f"ação desconhecida: {action or '(vazia)'}",
                     "actions": ["caps", "messages", "notices"]}
    except Exception as exc:  # noqa: BLE001 - painel recebe erro, nao 500 cru
        return 500, {"error": str(exc)[:300]}
