"""
Bundle: o estado pessoal viaja do navegador para o backend a cada requisição.

O backend é **sem estado**. Nada de localKey, cookie de sessão ou código IR
é gravado em disco — tudo chega no header `X-Nebula-Bundle`, base64 de um JSON,
e some quando a requisição termina. O navegador é o dono do segredo.

Formato:

    {
      "v": 1,
      "keys": { "<deviceId>": {"localKey": "...", "ver": "3.3", "ip": "...",
                               "name": "...", "kind": "...", "role": "..."} },
      "cloud": {"host": "protect-us.ismartlife.me", "region": "us-west",
                "uid": "...", "email": "...", "accessToken": "...",
                "mobileApiUrl": "https://a1.tuyaus.com",
                "cookies": [{"name","value"}]},
      "ir":   {"head": "...", "keys": {"power": {"pulse": "..."}}}
    }

Em `keys` mora também quem foi **achado na rede sem chave**: a API web da
Tuya não devolve localKey, então o scan é a única forma de descobrir esses
aparelhos. Entrada só com ip/ver fica no inventário como não controlável.

Um bundle ausente, inválido ou velho nunca derruba o servidor: vira um bundle
vazio e a API segue funcionando — só não há o que controlar.
"""

from __future__ import annotations

import base64
import binascii
import json

HEADER = "X-Nebula-Bundle"
VERSION = 1
MAX_BYTES = 1_000_000  # folgado; o bundle real fica em ~8 KB


def empty() -> dict:
    return {"v": VERSION, "keys": {}, "cloud": None, "ir": None}


def parse(raw: str | bytes | None) -> dict:
    """Best-effort: qualquer coisa errada devolve um bundle vazio."""
    b = empty()
    if not raw:
        return b
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("ascii")
        except UnicodeDecodeError:
            return b
    if len(raw) > MAX_BYTES:
        return b
    try:
        data = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except (ValueError, binascii.Error, TypeError):
        return b
    if not isinstance(data, dict):
        return b

    keys = data.get("keys")
    if isinstance(keys, dict):
        # Entrada sem localKey não vira chave: o registry segue calculando
        # `local` a partir da localKey, então ela não dá controle a ninguém.
        # Mas um device encontrado no scan chega aqui só com ip/ver — se
        # fosse descartado, ele sumiria da lista a cada requisição seguinte.
        b["keys"] = {
            str(k): v for k, v in keys.items()
            if isinstance(v, dict) and (v.get("localKey") or v.get("ip"))
        }
    cloud = data.get("cloud")
    if isinstance(cloud, dict) and isinstance(cloud.get("cookies"), list):
        b["cloud"] = {
            "host": str(cloud.get("host") or ""),
            "region": str(cloud.get("region") or ""),
            "uid": str(cloud.get("uid") or ""),
            "email": str(cloud.get("email") or ""),
            # session do gateway móvel: sem o accessToken nao da para assinar
            # nenhuma chamada, e sem ele o controle remoto nao funciona
            "accessToken": str(cloud.get("accessToken") or ""),
            "sid": str(cloud.get("sid") or ""),
            "mobileApiUrl": str(cloud.get("mobileApiUrl") or ""),
            "cookies": [
                {"name": str(c.get("name")), "value": str(c.get("value"))}
                for c in cloud["cookies"]
                if isinstance(c, dict) and c.get("name")
            ],
        }
    ir = data.get("ir")
    if isinstance(ir, dict) and isinstance(ir.get("keys"), dict) and ir.get("head"):
        b["ir"] = {"head": str(ir["head"]), "keys": dict(ir["keys"])}
    return b


def serialize(bundle: dict) -> str:
    payload = {
        "v": VERSION,
        "keys": bundle.get("keys") or {},
        "cloud": bundle.get("cloud"),
        "ir": bundle.get("ir"),
    }
    return base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode()


def key_for(bundle: dict, device_id: str) -> dict:
    k = (bundle.get("keys") or {}).get(device_id)
    return k if isinstance(k, dict) else {}


def is_empty(bundle: dict) -> bool:
    return not (bundle.get("keys") or bundle.get("cloud") or bundle.get("ir"))


def describe(bundle: dict) -> dict:
    """Resumo sem segredo, para a UI mostrar o que está carregado."""
    cloud = bundle.get("cloud") or {}
    return {
        "version": VERSION,
        "keys": len(bundle.get("keys") or {}),
        "cloud": bool(cloud),
        "cloud_email": cloud.get("email") or None,
        "cloud_region": cloud.get("region") or None,
        "ir_codes": len(((bundle.get("ir") or {}).get("keys") or {})),
    }