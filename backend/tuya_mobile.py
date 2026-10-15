"""
Gateway móvel da Tuya -- o mesmo endpoint que o app Tuya Smart usa, em Python puro.

Por que existe: a API web (Protect/Smart Life, `protect-<regiao>.ismartlife.me`)
NAO devolve a `localKey` de nenhum dispositivo. O gateway móvel devolve, e é o
único caminho programático para ela sem IMPORTAR o bundle na mão.

A assinatura NUNCA foi um whitebox: `libthing_security.so` implementa
HMAC-SHA256 com a chave embutida, e a "aritmetica racional" da
`libthing_security_algorithm.so` é só o SHA-256 (`computeDigest`) compilado
dentro da lib com o MPIR da Tuya. Reimplementação verificada contra 554 vetores
capturados do app real (257 assinaturas + 297 chaves `getEncryptoKey` + `chKey`),
todos batendo byte a byte.

    G     = <package>_<cert SHA-256 em hex maiúsculo com ':'>_<appKey>_<appSecret>
    chKey = HMAC_SHA256(appId, "<package>_<cert:hex>").hexdigest()[8:16]
    sign  = HMAC_SHA256(SHA256(G), <string canônica>).hexdigest()
    aes16 = ascii(HMAC_SHA256(requestId, G + "_" + ecode).hexdigest()[:16])

A string canônica são os campos da whitelist ordenados, unidos por `||`, com
`postData` entrando como `swapSignString(MD5Util.md5AsBase64(postData))` — onde
`swapSignString(s) = s[8:16] + s[0:8] + s[24:32] + s[16:24]`.

`et=3` significa corpo cifrado: `postData = base64(nonce12 ‖ AESGCM(aes16))`,
usando `aes16` como chave de 16 BYTES ASCII (não 16 bytes de hex).

O app usa `clientId=3cxxt3au9x33ytvq3h9j` (19 caracteres). Sem ele o gateway
responde `ILLEGAL_CLIENT_ID`; com ele e assinatura errada, `SING_VALIDATE_FALED`.
"""

from __future__ import annotations

import base64
import collections
import hashlib
import hmac
import json
import os
import time
import uuid
from typing import Any, Iterator

import requests
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# --- identidade do app (extraída do Tuya Smart 7.11.4, região internacional) --
# Material de engenharia reversa do app oficial, sobrescrevível por ambiente.
# Publicar esses valores é prática comum em PoCs (ex.: tinytuya), mas eles
# pertencem à Tuya e podem ser rotacionados — use por sua conta, sem afiliação.
PACKAGE = os.environ.get("TUYA_PACKAGE", "com.tuya.smart")
CLIENT_ID = os.environ.get("TUYA_CLIENT_ID", "3cxxt3au9x33ytvq3h9j")
APP_KEY = os.environ.get("TUYA_APP_KEY", "f3hd7pet4p83kemjdf5wqsa5tavrv579")
APP_SECRET = os.environ.get("TUYA_APP_SECRET", "5gdtanjtf38vyxkqh87cjwfcqjhvjjqa")
CERT_SHA256 = os.environ.get(
    "TUYA_CERT_SHA256",
    "93219FC273E2200F4ADEE5F7191DC656BA2A2D7B2FF5D24CD55C4B6155001E40")

APP_VERSION = "7.11.4"
APP_RN_VERSION = "7.8"
SDK_VERSION = "7.11.0"
DEVICE_CORE_VERSION = "7.11.0"
TTID = "international"
LANG = "en_US"
OS_SYSTEM = "14"
PLATFORM = "sdk_gphone64_arm64"
CHANNEL = "oem"
TIMEZONE = os.environ.get("TUYA_TIMEZONE", "UTC")

GATEWAY_FALLBACK = "https://a1.tuyaus.com"
# Identificador de instância do APP. NÃO é dado da conta: é só o id estável
# que o formulário assinado carrega; qualquer valor estável serve.
# Sem TUYA_DEVICE_ID, gera um aleatório por processo (evita publicar
# fingerprint capturado de tráfego real).
def _default_device_id() -> str:
    return uuid.uuid4().hex + uuid.uuid4().hex[:8]


DEVICE_ID = os.environ.get("TUYA_DEVICE_ID") or _default_device_id()

API_HOME_LIST = "m.life.home.space.list"
API_DEVICE_LIST = "m.life.my.group.device.list"
API_BATCH = "smartlife.m.api.batch.invoke"

# Campos que entram na string canônica (ThingApiSignManager.SIGN_WHITELIST).
SIGN_FIELDS = frozenset({
    "a", "v", "lang", "deviceId", "appVersion", "ttid", "isH5", "h5Token",
    "os", "clientId", "postData", "time", "requestId", "et", "n4h5", "sid",
    "chKey", "sp",
})

ERR_NO_CLIENT = "ILLEGAL_CLIENT_ID"
ERR_BAD_SIGN = "SING_VALIDATE_FALED"
ERR_BAD_ROUTE = "API_OR_API_VERSION_WRONG"


class GatewayError(RuntimeError):
    pass


# --- primitivas de assinatura ------------------------------------------------
def _colon_hex(cert_sha256_hex: str) -> str:
    """SHA-256 do certificado no formato Android: MAÚSCULO, dois dígitos, ':'."""
    h = cert_sha256_hex.replace(":", "").strip()
    return ":".join(h[i:i + 2] for i in range(0, len(h), 2)).upper()


def _cert_msg() -> str:
    return f"{PACKAGE}_{_colon_hex(CERT_SHA256)}"


def global_material() -> str:
    """A string G de que sai a chave de assinatura."""
    return f"{_cert_msg()}_{APP_KEY}_{APP_SECRET}"


def sign(canonical: str) -> str:
    key = hashlib.sha256(global_material().encode()).digest()
    return hmac.new(key, canonical.encode(), hashlib.sha256).hexdigest()


def derive_key(request_id: str, ecode: str | None) -> bytes:
    """Chave AES de 16 bytes (ASCII) derivada por requisição."""
    g = global_material()
    message = f"{g}_{ecode}" if ecode else g
    return hmac.new(request_id.encode(), message.encode(),
                    hashlib.sha256).hexdigest()[:16].encode()


def channel_key() -> str:
    return hmac.new(CLIENT_ID.encode(), _cert_msg().encode(),
                    hashlib.sha256).hexdigest()[8:16]


def swap_md5(value: str) -> str:
    digest = hashlib.md5(value.encode()).hexdigest()
    return digest[8:16] + digest[0:8] + digest[24:32] + digest[16:24]


def canonical_string(params: dict[str, str]) -> str:
    parts = []
    for key in sorted(params):
        value = params[key]
        if key in SIGN_FIELDS and value:
            parts.append(f"{key}={swap_md5(value) if key == 'postData' else value}")
    return "||".join(parts)


# --- corpo et=3 ---------------------------------------------------------------
def encrypt_body(key: bytes, payload: dict[str, Any]) -> str:
    nonce = os.urandom(12)
    body = json.dumps(payload, separators=(",", ":"),
                      ensure_ascii=False).encode()
    return base64.b64encode(nonce + AESGCM(key).encrypt(nonce, body, None)).decode()


def decrypt_body(key: bytes, value: str) -> Any:
    raw = base64.b64decode(value)
    return json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], None).decode())


# --- transporte ---------------------------------------------------------------
def gateway_url(login_result: dict, fallback: str = GATEWAY_FALLBACK) -> str:
    """URL do gateway, preferindo o host que o próprio login devolveu."""
    domain = (login_result or {}).get("domain") or {}
    base = str(domain.get("mobileApiUrl") or fallback).rstrip("/")
    return f"{base}/api.json"


def call(action: str, payload: dict[str, Any], *, sid: str = "", ecode: str = "",
         endpoint: str = "", version: str = "1.0", timeout: int = 20,
         session: requests.Session | None = None,
         form_extra: dict[str, Any] | None = None) -> Any:
    """Uma chamada assinada ao gateway móvel, já descriptografada.

    `form_extra` põe campos no **formulário** em vez do corpo cifrado — é o
    que a família `thing.m.linkage.*` e a `tuya.m.infrared.*` exigem com o
    `gid`. `canonical_string` só assina os campos da whitelist, então um
    campo extra entra no formulário sem alterar a string canônica.
    """
    url = endpoint or f"{GATEWAY_FALLBACK}/api.json"
    request_id = str(uuid.uuid4())
    key = derive_key(request_id, ecode or None)
    form = {
        "a": action,
        "v": version,
        "clientId": CLIENT_ID,
        "deviceId": DEVICE_ID,
        "appVersion": APP_VERSION,
        "appRnVersion": APP_RN_VERSION,
        "sdkVersion": SDK_VERSION,
        "deviceCoreVersion": DEVICE_CORE_VERSION,
        "lang": LANG,
        "os": "Android",
        "osSystem": OS_SYSTEM,
        "platform": PLATFORM,
        "channel": CHANNEL,
        "ttid": TTID,
        "timeZoneId": TIMEZONE,
        "cp": "gzip",
        "nd": "1",
        "et": "3",
        "chKey": channel_key(),
        "time": str(int(time.time())),
        "requestId": request_id,
        "postData": encrypt_body(key, payload),
        "bizData": "{}",
    }
    if sid:
        form["sid"] = sid
    form.update(form_extra or {})
    form["sign"] = sign(canonical_string(form))

    http = session or requests
    try:
        response = http.post(url, data=form, timeout=timeout,
                             headers={"User-Agent": f"TY/{APP_VERSION}"})
        envelope = response.json()
    except requests.RequestException as exc:
        raise GatewayError(f"rede falhou em {url}: {exc}") from exc
    except ValueError as exc:
        raise GatewayError(f"resposta não-JSON de {url}") from exc

    if "result" not in envelope:
        code = str(envelope.get("errorCode") or "")
        msg = str(envelope.get("errorMsg") or envelope.get("msg") or envelope)
        if code == ERR_NO_CLIENT:
            raise GatewayError(f"clientId rejeitado por {url}: {code}")
        if code == ERR_BAD_SIGN:
            raise GatewayError(f"{url}: {code} — assinatura recusada")
        if code == ERR_BAD_ROUTE:
            raise GatewayError(f"{url}: {code} — rota/versão inválida")
        raise GatewayError(f"{action}: {code or 'sem código'} {msg}"[:200])

    try:
        return decrypt_body(key, envelope["result"])
    except Exception as exc:  # noqa: BLE001
        raise GatewayError(f"{action}: resposta não decifrou ({exc})") from exc


# --- extração -----------------------------------------------------------------
def _walk(value: Any) -> Iterator[dict]:
    stack = [value]
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            yield current
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)


def _find(value: Any, fields: tuple[str, ...]) -> dict | None:
    for node in _walk(value):
        if all(node.get(f) for f in fields):
            return node
    return None


def _session_ids(login_result: dict, cookies: list | None) -> tuple[str, str]:
    """
    O gateway móvel quer o par (sid, ecode). No login web o `ecode` é o
    `accessToken` do result e o `sid` vem do cookie de sessão.
    """
    lr = login_result or {}
    sid = str(lr.get("sid") or "")
    for cookie in cookies or []:
        if str(cookie.get("name") or "") == "sid" and cookie.get("value"):
            sid = str(cookie["value"])
            break
    ecode = str(lr.get("ecode") or lr.get("accessToken") or lr.get("access_token") or "")
    return sid, ecode


def _home_ids(result: Any) -> list[str]:
    gids: list[str] = []
    for node in _walk(result):
        gid = node.get("gid") or node.get("groupId") or node.get("homeId")
        if gid and str(gid) not in gids:
            gids.append(str(gid))
    return gids


def fetch_devices(login_result: dict, cookies: list | None = None,
                   session: requests.Session | None = None) -> list[dict]:
    """Todos os dispositivos da conta, cada um com a sua `localKey`."""
    sid, ecode = _session_ids(login_result, cookies)
    if not ecode:
        raise GatewayError("login sem accessToken/ecode: refaça o login")
    url = gateway_url(login_result)

    gids: list[str] = []
    try:
        gids = _home_ids(call(API_HOME_LIST, {}, sid=sid, ecode=ecode,
                              endpoint=url, session=session))
    except GatewayError:
        gids = []  # sem homes: tenta a lista global abaixo

    devices: list[dict] = []
    for gid in gids or [""]:
        payload = {"gid": gid} if gid else {}
        for version in ("1.0", "2.2"):
            try:
                result = call(API_DEVICE_LIST, payload, sid=sid, ecode=ecode,
                              endpoint=url, version=version, session=session)
            except GatewayError:
                continue
            for node in _walk(result):
                if node.get("devId") or node.get("deviceId"):
                    devices.append(node)
            break
    return devices


def keys_from_devices(devices: list[dict]) -> dict[str, dict]:
    """Achata a resposta no formato que o frontend consome."""
    out: dict[str, dict] = {}
    for device in devices or []:
        if not isinstance(device, dict):
            continue
        dev_id = str(device.get("devId") or device.get("id") or "")
        local_key = str(device.get("localKey") or "").strip()
        if not dev_id or not local_key:
            continue  # dispositivo virtual não tem chave local
        out[dev_id] = {
            "localKey": local_key,
            "name": device.get("name") or "",
            "ip": device.get("ip") or "",
            "ver": str(device.get("verSw") or ""),
            "productId": str(device.get("productId") or ""),
        }
    return out


def fetch_keys(login_result: dict, cookies: list | None = None) -> tuple[dict, str]:
    """
    Atalho usado pelo login. Devolve (chaves, aviso). Nunca levanta: um login
    válido não pode virar erro 500 só porque o gateway móvel recusou.
    """
    try:
        return keys_from_devices(fetch_devices(login_result, cookies)), ""
    except GatewayError as exc:
        return {}, str(exc)[:180]
    except Exception as exc:  # noqa: BLE001
        return {}, f"gateway móvel indisponível: {exc}"[:180]


# --- controle remoto ----------------------------------------------------------
# O app não depende da LAN: ele manda DPS pelo gateway móvel e o Tuya relay
# entrega. É por isso que dá para acender a luz de casa do 4G no app. Fazemos
# o mesmo — estas duas APIs são as que o próprio app usa.
API_DP_GET = "s.m.dev.dp.get"
API_DP_PUBLISH = "thing.m.device.dp.publish"


def session_from_cloud(cloud: dict) -> tuple[str, str, str]:
    """(sid, ecode, endpoint) tirados do bloco `cloud` que o bundle carrega."""
    cloud = cloud or {}
    # o `sid` do login é o que amarra a sessão; os cookies web não têm um limpo
    sid, ecode = _session_ids({"sid": cloud.get("sid")}, cloud.get("cookies"))
    ecode = str(cloud.get("accessToken") or ecode or "")
    url = gateway_url({"domain": {"mobileApiUrl": cloud.get("mobileApiUrl")}})
    return sid, ecode, url


def _dps_from(result: Any) -> dict:
    """A resposta de dp vem aninhada em `result`/`dps`, conforme a API."""
    for node in _walk(result):
        dps = node.get("dps")
        if isinstance(dps, dict) and dps:
            return dps
    return {}


def cloud_status(dev_id: str, cloud: dict, gw_id: str = "",
                 session: requests.Session | None = None) -> dict:
    """Estado do aparelho pela nuvem. Devolve {'dps': {...}}."""
    sid, ecode, url = session_from_cloud(cloud)
    if not ecode:
        raise GatewayError("sem accessToken: entre com e-mail e senha (QR não libera controle remoto)")
    # a lista de devices não devolve gwId; para aparelho direto o próprio
    # devId serve — mandar vazio dá IS_BLANK/gwIdBlank
    result = call(API_DP_GET, {"devId": dev_id, "gwId": gw_id or dev_id},
                  sid=sid, ecode=ecode, endpoint=url, session=session)
    return {"dps": _dps_from(result)}


def cloud_publish(dev_id: str, dps: dict, cloud: dict, gw_id: str = "",
                  session: requests.Session | None = None) -> dict:
    """Manda um comando DPS pela nuvem — o mesmo caminho do app."""
    sid, ecode, url = session_from_cloud(cloud)
    if not ecode:
        raise GatewayError("sem accessToken: entre com e-mail e senha (QR não libera controle remoto)")
    result = call(API_DP_PUBLISH,
                  {"devId": dev_id, "gwId": gw_id or dev_id,
                   "dps": json.dumps(dps, separators=(",", ":"))},
                  sid=sid, ecode=ecode, endpoint=url, session=session)
    bad = next((n for n in _walk(result)
                if n.get("success") is False or n.get("errorCode")), None)
    if bad:
        raise GatewayError(
            f"{bad.get('errorCode') or 'erro'} "
            f"{bad.get('errorMsg') or bad.get('msg') or ''}".strip()[:160])
    return {"dps": _dps_from(result)}

# --- IR inteligente: os códigos do controle virtual -------------------------
# Um "IR inteligente" (TV, ar-condicionado) na conta **não é** um dispositivo
# de verdade: é um *sub-device virtual* pendurado num blaster físico. O app
# busca os botões em três APIs da família `tuya.m.infrared.*`, nesta ordem:
#
#   1. `tuya.m.infrared.record.get`  (1.0) -> metadados do controle.
#      Params: {devId, gwId, subDevId, vender:"3"}.
#      O `gwId` do pedido é **ignorado**; quem responde é o campo `gwId` do
#      retorno (o blaster real, nem sempre o óbvio pelo nome na lista).
#      Devolve `remoteId` + `devTypeId`, que são obrigatórios no passo 2.
#      `exts` é uma string JSON; `exts.study == 6` marca controle RF/433.
#
#   2. `tuya.m.infrared.keydata.get` (2.0) -> os botões do controle.
#      Params: {devId, devTypeId, gwId, remoteId, subDevId, vender:"3"}.
#      Sem `devTypeId` o gateway responde REMOTE_API_PARAM_ALL_INPUT_LOSS.
#      Devolve `compressPulseList`: {key, keyId, keyName, compressPulse, exts}.
#      `compressPulse` é o texto do pulso já comprimido; o *header* do protocolo
#      vem em `exts`, que é uma **string** JSON cuja chave "99999" é o head hex.
#
#   3. `tuya.m.infrared.learn.get`   (1.0) -> o que o usuário aprendeu no
#      blaster apontando para o controle de verdade (DIY/study).
#      Params: {devId, gwId, subDevId, vender:"3"} (só `subDevId` conta).
#      Aqui `compressPulse` é **HEX** do sinal cru, e vem `frequency`.
#
# As três exigem o `gid` da casa no **formulário** (fora do corpo cifrado) —
# é a mesma pegadinha do `thing.m.linkage.rule.query`. No corpo ele não vale.
API_IR_RECORD = "tuya.m.infrared.record.get"
API_IR_KEYDATA = "tuya.m.infrared.keydata.get"
API_IR_LEARN = "tuya.m.infrared.learn.get"

IR_VENDER = "3"
# símbolos de tempo do "key1", na ordem em que o head os consome
IR_KEY1_SYMBOLS = "@#$%^&*()QWRLTXKVNM{}[]JUP<>|=HS~"


def _ir_form(gid: str) -> dict[str, str] | None:
    return {"gid": str(gid)} if gid else None


def ir_virtual_remotes(cloud: dict, gid: str = "",
                       session: requests.Session | None = None) -> list[dict]:
    """
    Lista os controles virtuais IR (TV, ar-condicionado, ...) da conta.

    Eles **não** aparecem na API web — só na lista 2.2 do gateway móvel — e a
    assinatura que os separa de um aparelho comum é dupla:

    - `otaInfo.otaModuleMap` tem a chave `infrared` (o controle é um módulo de
      IR do blaster, não um produto com firmware próprio);
    - `deviceTopo.parentDevId` (e `communication.communicationNode`) aponta o
      blaster dono dele — que é exatamente o `gwId` que as APIs infrared pedem.

    Por isso esta função também resolve o gateway de cada controle, o que
    dispensa o app mandar `gwId`.
    """
    sid, ecode, url = session_from_cloud(cloud)
    if not ecode:
        return []
    gid = str(gid or _ir_home_gid(cloud, sid, ecode, url, session))
    try:
        raw = call(API_DEVICE_LIST, {"gid": gid} if gid else {}, sid=sid,
                   ecode=ecode, endpoint=url, version="2.2", session=session)
    except GatewayError:
        return []
    out = []
    for node in _walk(raw):
        dev_id = str(node.get("devId") or "")
        if not dev_id:
            continue
        modules = (node.get("otaInfo") or {}).get("otaModuleMap") or {}
        topo = node.get("deviceTopo") or {}
        gw = str(topo.get("parentDevId")
                 or (node.get("communication") or {}).get("communicationNode")
                 or "")
        out.append({
            "devId": dev_id,
            "name": str(node.get("name") or ""),
            "productId": str(node.get("productId") or ""),
            "gwId": gw,
            "is_ir_remote": "infrared" in modules,
            "is_blaster": bool(node.get("localKey")) and not gw,
            "has_key": bool(node.get("localKey")),
        })
    return out


def _ir_home_gid(cloud: dict, sid: str, ecode: str, url: str,
                 session: requests.Session | None = None) -> str:
    """`gid` da primeira casa — as APIs IR exigem ele no formulário."""
    try:
        homes = call(API_HOME_LIST, {}, sid=sid, ecode=ecode, endpoint=url,
                     session=session)
    except GatewayError:
        return ""
    gids = _home_ids(homes)
    return gids[0] if gids else ""


def _ir_exts(value: Any) -> dict:
    """`exts` chega como string JSON (e às vezes já como objeto)."""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except ValueError:
            return {}
    return {}


def ir_head_of(exts: Any) -> str:
    """O head hex mora em `exts["99999"]` — o id da "extensão" do protocolo."""
    return str(_ir_exts(exts).get("99999") or "")


def ir_decode_head(head: str) -> dict:
    """
    Head = `[u8 type][u16 timescale][u16 rsv][u16 rsv][u16 n] + n*u16 timings`.

    `timescale` é um divisor de tempo, não uma frequência: o tempo real de um
    tick é `100000 / timescale` microssegundos (convenção do
    tinytuya.IRRemoteControlDevice). Os símbolos saem da tabela
    `@#$%^&*()QWRLTXKVNM{}[]JUP<>|=HS~`, na ordem em que aparecem.
    """
    raw = bytes.fromhex(head) if head else b""
    if len(raw) < 9:
        return {}
    kind, timescale, _, _, n = int.from_bytes(raw[0:1], "big"), \
        int.from_bytes(raw[1:3], "big"), int.from_bytes(raw[3:5], "big"), \
        int.from_bytes(raw[5:7], "big"), int.from_bytes(raw[7:9], "big")
    if len(raw) != (n * 2 + 9):
        return {"kind": kind, "timescale": timescale, "n": n, "valid": False}
    timebase = (100000.0 / timescale) if timescale else 0.0
    timings = [int.from_bytes(raw[9 + 2 * i:11 + 2 * i], "big") for i in range(n)]
    symbols = IR_KEY1_SYMBOLS[:n]
    return {
        "kind": kind, "timescale": timescale, "n": n, "valid": True,
        "tick_us": round(timebase, 3),
        "symbols": {s: round(t * timebase) for s, t in zip(symbols, timings)},
        "raw_timings": timings,
    }


def ir_split_pulse(pulse: str) -> dict:
    """
    `compressPulse` é `AA<corpo>` por quadro — `AA` em hex é o número de
    repetições — e quadros vêm separados por `:`. Alguns appliance devolvem
    um objeto JSON truncado (sem a chave final) em vez do texto puro; nesse
    caso o head e a key1 estão dentro dele.
    """
    text = str(pulse or "")
    if text.lstrip().startswith("{"):
        blob = text if text.rstrip().endswith("}") else text.rstrip() + "}"
        try:
            obj = json.loads(blob)
        except ValueError:
            obj = {}
        if isinstance(obj, dict) and (obj.get("key1") or obj.get("head")):
            return {"head": str(obj.get("head") or ""),
                    "pulse": str(obj.get("key1") or ""),
                    "delay": obj.get("delay"), "ver": obj.get("ver")}
    frames = []
    for part in text.split(":"):
        part = part.strip()
        if len(part) >= 2:
            try:
                frames.append({"repeat": int(part[:2], 16), "body": part[2:]})
            except ValueError:
                frames.append({"repeat": None, "body": part})
        elif part:
            frames.append({"repeat": None, "body": part})
    return {"pulse": text, "frames": frames}


def ir_cloud_keys(dev_id: str, cloud: dict, *, gw_id: str = "", gid: str = "",
                  dev_type_id: str = "", remote_id: str = "",
                  with_learned: bool = True,
                  session: requests.Session | None = None) -> dict:
    """
    Baixa da nuvem os botões de um controle virtual IR.

    Devolve o registro do controle, os botões já no formato que o bundle usa
    (`{"head": ..., "keys": {nome: {"name","pulse","freq","keyId"}}}`) e,
    quando pedido, os códigos aprendidos no blaster. Nunca levanta por falta de
    sessão — devolve `{"error": ...}` para a UI explicar o que falta.
    """
    sid, ecode, url = session_from_cloud(cloud)
    if not ecode:
        return {"error": "sem accessToken: entre com e-mail e senha",
                "devId": dev_id}
    gid = str(gid or _ir_home_gid(cloud, sid, ecode, url, session))
    form = _ir_form(gid)

    # o `gwId` do pedido é ignorado pelo servidor, mas ele não é adivinhável:
    # o blaster dono do controle vem da topologia da lista 2.2.
    if not gw_id:
        for remote in ir_virtual_remotes(cloud, gid, session):
            if remote["devId"] == dev_id and remote.get("gwId"):
                gw_id = remote["gwId"]
                break

    def ask(action: str, payload: dict, version: str) -> Any:
        # todas as respostas dessa família trazem `success`/`errorCode` no
        # corpo decifrado; quem não trouxer `result` é erro de servidor.
        raw = call(action, payload, sid=sid, ecode=ecode, endpoint=url,
                   version=version, session=session, form_extra=form)
        if isinstance(raw, dict) and "result" in raw:
            raw = raw["result"]
        if isinstance(raw, dict) and raw.get("success") is False:
            raise GatewayError(f"{action}: {raw.get('errorCode')} "
                               f"{raw.get('errorMsg') or ''}".strip()[:160])
        return raw

    # 1) metadados: quem é o blaster, qual o remoteId e o devTypeId
    record: dict = {}
    if not (dev_type_id and remote_id):
        record = ask(API_IR_RECORD,
                     {"devId": dev_id, "gwId": gw_id or dev_id,
                      "subDevId": gw_id or dev_id, "vender": IR_VENDER},
                     "1.0") or {}
        if not isinstance(record, dict):
            record = {}
    dev_type_id = str(dev_type_id or record.get("devTypeId") or "")
    remote_id = str(remote_id or record.get("remoteId") or "")
    gw_id = str(record.get("gwId") or gw_id or dev_id)
    if not dev_type_id or not remote_id:
        return {"error": "controle IR sem remoteId/devTypeId (record.get)",
                "devId": dev_id, "record": record}

    # 2) botões
    keydata = ask(API_IR_KEYDATA,
                  {"devId": dev_id, "devTypeId": dev_type_id, "gwId": gw_id,
                   "remoteId": remote_id, "subDevId": dev_id,
                   "vender": IR_VENDER},
                  "2.0") or {}
    entries = keydata.get("compressPulseList") or [] if isinstance(keydata, dict) else []

    keys: dict[str, dict] = {}
    heads: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("key") or entry.get("keyName") or "").strip()
        if not name:
            continue
        split = ir_split_pulse(entry.get("compressPulse"))
        entry_head = ir_head_of(entry.get("exts")) or split.get("head") or ""
        heads.append(entry_head)
        keys[name] = {
            "name": str(entry.get("keyName") or name),
            "pulse": str(split.get("pulse") or ""),
            "freq": int(entry.get("frequency") or 0) or None,
            "keyId": entry.get("keyId"),
            "frames": split.get("frames") or [],
            "head": entry_head,
        }
    # um controle é um protocolo só: o head do bloco `ir` é o mais comum, senão
    # um botão com head diferente quebraria todos os outros no envio.
    head = collections.Counter(h for h in heads if h).most_common(1)[0][0] if any(heads) else ""

    out = {
        "devId": dev_id, "gwId": gw_id, "remoteId": remote_id,
        "devTypeId": dev_type_id,
        "brandId": record.get("brandId"), "brandName": record.get("brandName"),
        "devTypeName": record.get("devTypeName"),
        "study": _ir_exts(record.get("exts")).get("study"),
        "head": head,
        "head_info": ir_decode_head(head),
        "keys": keys,
        "count": len(keys),
        "gid": gid,
        "record": record,
    }

    # 3) o que foi aprendido no blaster (DIY). `compressPulse` vem em HEX.
    if with_learned:
        try:
            raw_learn = ask(API_IR_LEARN,
                            {"devId": gw_id, "gwId": gw_id, "subDevId": dev_id,
                             "vender": IR_VENDER}, "1.0")
        except GatewayError as exc:
            out["learned_error"] = str(exc)[:160]
            raw_learn = []
        learned = []
        for item in raw_learn if isinstance(raw_learn, list) else []:
            if not isinstance(item, dict):
                continue
            hexed = str(item.get("compressPulse") or "")
            try:
                raw_bytes = bytes.fromhex(hexed)
                b64 = base64.b64encode(raw_bytes).decode()
            except (ValueError, TypeError):
                b64 = ""
            learned.append({
                "keyId": item.get("keyId"), "key": item.get("key"),
                "name": item.get("keyName"), "hex": hexed, "base64": b64,
                "freq": int(item.get("frequency") or 0) or None,
                "bytes": len(raw_bytes) // 2,
            })
        out["learned"] = learned
        out["learned_count"] = len(learned)
    return out
