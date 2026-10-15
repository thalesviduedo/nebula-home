"""
Replica do login da conta Tuya Smart (mesmo caminho que o app usa).

O app Tuya Smart 7.x nao talking em texto plano com host nenhum dentro do APK:
as URLs e o material de assinatura estao num blob AES (assets/thingDuckBody.txt).
O que o app faz de fato, por baixo, e o login do "Smart Life / Protect" web client:
um par de chamadas REST que devolvem uma sessao por cookie. Este modulo
reimplementa exatamente esse par, e a partir dele da para:

  * listar os dispositivos da conta (inclusive os que so funcionam via P2P/nuvem)
  * abrir sessao WebRTC e receber video H.264/H.265 sem o emulador
  * guardar a sessao para o backend Python usar

Endpoints (confirmados em pkg/tuya/api.go do seydx/tuya-ipc-terminal e
verificados ao vivo contra o host):

  POST /api/login/security/QCtoken   -> devolve o token do QR
  POST /api/login/poll               -> devolve LoginResult + cookies de sessao

Uso:
    python3 tuya_cloud.py qr --region us-west --email voce@exemplo.com
    python3 tuya_cloud.py devices
    python3 tuya_cloud.py whoami
"""

from __future__ import annotations

import argparse
import base64
import re
import datetime as _dt
import json
import os
import sys
import time
from pathlib import Path

import requests
from urllib.parse import unquote

# ---------------------------------------------------------------------------
# Regioes. O Brasil nao tem regiao propria na Tuya: cai na America Zone (AZ).
# Confirmado em cmd/auth/utils.go e testado ao vivo (DNS + TLS) neste host.
# ---------------------------------------------------------------------------
REGIONS = {
    "us-west": ("protect-us.ismartlife.me", "West America"),
    "us-east": ("protect-ue.ismartlife.me", "East America"),
    "eu-central": ("protect-eu.ismartlife.me", "Central Europe"),
    "eu-east": ("protect-we.ismartlife.me", "East Europe"),
    "china": ("protect.ismartlife.me", "China"),
    "india": ("protect-in.ismartlife.me", "India"),
}

APP_DIR = Path(__file__).resolve().parent
# O backend nao grava sessao em disco: o navegador manda os cookies no bundle
# a cada requisicao (header X-Nebula-Bundle). Ver tuya_bundle.py.

_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class TuyaCloudError(RuntimeError):
    pass


def host_for(region: str) -> str:
    if region not in REGIONS:
        raise TuyaCloudError(
            f"regiao invalida: {region!r} (use uma de {', '.join(REGIONS)})"
        )
    return REGIONS[region][0]


def _iso(dt: _dt.datetime | None = None) -> str:
    dt = dt or _dt.datetime.now(_dt.timezone.utc)
    return dt.astimezone(_dt.timezone.utc).isoformat().replace("+00:00", "Z")


def new_client(host: str) -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "User-Agent": _UA,
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": f"https://{host}",
            "Referer": f"https://{host}/login",
            "X-Requested-With": "XMLHttpRequest",
        }
    )
    return s


def _post(host: str, path: str, payload: dict, sess: requests.Session) -> dict:
    url = f"https://{host}{path}"
    try:
        r = sess.post(url, json=payload, timeout=20)
    except requests.RequestException as exc:
        raise TuyaCloudError(f"rede falhou em {url}: {exc}") from exc
    if r.status_code != 200:
        raise TuyaCloudError(f"HTTP {r.status_code} em {url}: {r.text[:300]}")
    try:
        return r.json()
    except ValueError as exc:
        raise TuyaCloudError(f"resposta nao-JSON em {url}: {r.text[:300]}") from exc


# ---------------------------------------------------------------------------
# Login por QR code. A senha nunca passa por esta maquina.
# ---------------------------------------------------------------------------
def request_qr_token(host: str, sess: requests.Session) -> str:
    data = _post(host, "/api/login/security/QCtoken", {}, sess)
    if not data.get("success"):
        raise TuyaCloudError(f"QCtoken recusado: {data.get('msg') or data}")
    token = data.get("result")
    if not token:
        raise TuyaCloudError("QCtoken devolveu resultado vazio")
    return token


def qr_payload(token: str) -> str:
    # Formato literal do app: ele le o token desta string como deep link.
    return f"tuyaSmart--qrLogin?token={token}"


# ---------------------------------------------------------------------------
# Login por e-mail + senha.
#
# Mesmo handshake que o app usa, em duas chamadas:
#   1) POST /api/login/token      -> devolve {token, pbKey} (chave pública RSA)
#   2) POST /api/private/email/login  (ou /phone/login)
# A senha nunca trafega em claro: mandamos md5(senha) em hex, cifrado com
# RSA PKCS#1 v1.5 sob a pbKey, e o resultado vai em hex.
# ---------------------------------------------------------------------------
_EMAIL_RE = __import__("re").compile(
    r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$"
)


def _is_email(value: str) -> bool:
    return bool(_EMAIL_RE.match(value or ""))


def _fetch_login_token(host: str, username: str, country_code: str,
                       sess: requests.Session) -> dict:
    data = _post(host, "/api/login/token", {
        "countryCode": country_code,
        "username": username,
        "isUid": False,
    }, sess)
    if not data.get("success") or not data.get("result"):
        raise TuyaCloudError(
            f"token de login recusado: {data.get('errorMsg') or data.get('msg') or data}")
    return data["result"]


def _encrypt_password(password: str, pb_key: str) -> str:
    """md5(hex) -> RSA PKCS#1v15 -> hex. Mesma ordem do app."""
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    import hashlib

    hashed = hashlib.md5(password.encode()).hexdigest().encode()
    pem = f"-----BEGIN PUBLIC KEY-----\n{pb_key}\n-----END PUBLIC KEY-----"
    key = serialization.load_pem_public_key(pem.encode())
    if not isinstance(key, rsa.RSAPublicKey):
        raise TuyaCloudError("a chave devolvida não é RSA")
    enc = key.encrypt(hashed, padding.PKCS1v15())
    return enc.hex()


def password_login(email: str, password: str, region: str = "us-west",
                   country_code: str = "55") -> dict:
    """
    Faz login e grava a sessão. Devolve o mesmo dicionário que `poll_login`.
    `country_code` é o código de discagem (55 = Brasil).
    """
    host = host_for(region)
    sess = new_client(host)
    ident = (email or "").strip()
    if not _is_email(ident):
        ident = re.sub(r"[^\d+]", "", ident)  # telefone: só dígitos
        if not ident:
            raise TuyaCloudError("informe e-mail ou telefone")
        if not ident.startswith("+"):
            ident = "+" + ident

    tok = _fetch_login_token(host, ident, country_code, sess)
    enc = _encrypt_password(password, tok.get("pbKey") or "")

    path = "/api/private/email/login" if _is_email(ident) else "/api/private/phone/login"
    body = {
        "countryCode": country_code,
        "passwd": enc,
        "token": tok["token"],
        "ifencrypt": 1,
        "options": '{"group":1}',
    }
    body["email" if _is_email(ident) else "mobile"] = ident

    data = _post(host, path, body, sess)
    if not data.get("success"):
        raise TuyaCloudError(
            f"login recusado: {data.get('errorMsg') or data.get('msg') or data}")

    result = data["result"]
    return {
        "loginResult": result,
        "cloud": cloud_block(host, region, result, _cookies_from(sess, host)),
        "uid": result.get("uid"),
        "email": result.get("email") or ident,
    }


def cloud_block(host: str, region: str, login_result: dict, cookies: list) -> dict:
    """Só o que o bundle precisa guardar. Nenhum byte vai para o disco."""
    domain = login_result.get("domain") or {}
    return {
        "host": host,
        "region": region,
        "uid": login_result.get("uid") or "",
        "email": login_result.get("email") or "",
        # o accessToken/ecode do gateway móvel: sem ele não dá para assinar
        # chamada nenhuma. É tão sensível quanto os cookies (que já ficam
        # guardados aqui), então mora no mesmo lugar — no navegador.
        "accessToken": (login_result.get("ecode")
                        or login_result.get("accessToken")
                        or login_result.get("access_token")
                        or ""),
        # o sid é o que o gateway usa pra achar a sessão e, com ela, o ecode
        # certo pra decifrar a resposta. Os cookies web não carregam um `sid`
        # limpo, então ele precisa vir daqui.
        "sid": str(login_result.get("sid") or ""),
        "mobileApiUrl": domain.get("mobileApiUrl") or "",
        "cookies": [
            {"name": c["name"], "value": c["value"]}
            for c in cookies
            if c.get("name")
        ],
    }


def poll_login(host: str, token: str, sess: requests.Session, timeout: int = 300):
    """Fica em polling ate o usuario aprovar no app. Devolve (login_result, cookies)."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        data = _post(host, "/api/login/poll", {"token": token}, sess)
        last = data
        result = data.get("result")
        # Enquanto o usuario nao aprovou no app o servidor devolve `result: true`
        # (so um ack). O login So vale quando `result` vira objeto e traz `uid`
        # -- e nesse momento os cookies de sessao ja foram emitidos.
        if data.get("success") and isinstance(result, dict) and result.get("uid"):
            return result, _cookies_from(sess, host)
        sys.stderr.write(f"  aguardando confirmacao no app...\r")
        sys.stderr.flush()
        time.sleep(2)
    raise TuyaCloudError(f"timeout esperando confirmacao no app (ultimo: {last})")


def _cookies_from(sess: requests.Session, host: str) -> list[dict]:
    out = []
    for c in sess.cookies:
        out.append(
            {
                "name": c.name,
                "value": c.value,
                "domain": c.domain or host,
                "path": c.path or "/",
                "expires": _iso(
                    _dt.datetime.fromtimestamp(c.expires, _dt.timezone.utc)
                )
                if c.expires
                else "0001-01-01T00:00:00Z",
                "secure": True,
                "httpOnly": True,
            }
        )
    return out


# -- Devices ---------------------------------------------------------------

def client_from_cookies(host: str, cookies: list[dict]) -> requests.Session:
    """
    Reconstrói uma sessão com os cookies que o navegador guardou no bundle.
    Nada é escrito em disco: a sessão vive só enquanto a chamada dura.
    """
    sess = new_client(host)
    for c in cookies or []:
        if not isinstance(c, dict):
            continue
        name, value = c.get("name"), c.get("value")
        if not name:
            continue
        domain = (c.get("domain") or host).lstrip(".")
        sess.cookies.set(
            name, value if value is not None else "",
            domain=domain, path=c.get("path") or "/",
        )
    return sess


def _uid_from_cookies(sess: requests.Session) -> str:
    """
    O cookie USER_ID chega em formatos diferentes conforme região/app:
    plain, "id%3D", ou JSON {"id": "..."} (requests guarda isso como dict).
    """
    for c in sess.cookies:
        if c.name != "USER_ID":
            continue
        v = c.value
        if isinstance(v, dict):
            return str(v.get("id") or "")
        v = unquote(str(v or "")).strip()
        if not v:
            continue
        # "abc%3D" é base64 com padding: o "=" é ruído, não separador
        if "=" in v and not v.endswith("="):
            v = v.rsplit("=", 1)[1]
        v = v.rstrip("=")
        if v:
            return v
    return ""


def list_devices(sess: requests.Session, host: str, uid: str = "") -> dict:
    """
    Lista a conta em `/v2.0/users/{uid}/devices`.

    O uid vem do resultado do login (QR ou senha). Só caímos para o cookie
    USER_ID quando o login não devolveu o uid — o fluxo por QR costuma
    entregar apenas cookies de sessão (`s-sid`/`fast-sid`).
    """
    uid = str(uid or "").strip() or _uid_from_cookies(sess)
    if not uid:
        raise TuyaCloudError("sem uid: refaça o login")

    data = _post(host, f"/v2.0/users/{uid}/devices", {
        "is_all": False,
        "group_id": "",
        "extra_codes": "",
    }, sess)
    if not data.get("success"):
        raise TuyaCloudError(
            f"devices recusados: {data.get('errorMsg') or data.get('msg') or data}")
    return data


def list_device_keys(login_result: dict, cookies: list | None = None) -> tuple[dict, str]:
    """
    Puxa as localKeys direto do gateway móvel -- a API web nunca devolve isso.
    Devolve (chaves, aviso) e nunca levanta: um login bom não pode virar erro
    500 porque o gateway recusou. Ver backend/tuya_mobile.py para o contrato.
    """
    import tuya_mobile

    return tuya_mobile.fetch_keys(login_result or {}, cookies)


def keys_from_cloud_devices(devices: list[dict]) -> dict:
    """
    Extrai localKey de uma listagem da nuvem, quando a API web a devolver.
    A API web normalmente NÃO devolve localKey (só o gateway móvel do app
    envia), mas alguns produtos/regiões ainda vêm com o campo — se vier,
    aproveitamos em vez de pedir o bundle na mão.
    """
    out = {}
    for d in devices or []:
        if not isinstance(d, dict):
            continue
        gid = str(d.get("id") or "")
        lk = (d.get("localKey") or "").strip()
        if not gid or not lk:
            continue
        out[gid] = {
            "localKey": lk,
            "name": d.get("name") or "",
            "ver": str(d.get("ver") or d.get("protocol_version") or ""),
            "ip": d.get("local_ip") or "",
        }
    return out
