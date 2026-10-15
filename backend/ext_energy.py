"""
Painel de ENERGIA, UNIDADES e INVENTÁRIO (devices ocultos) da casa.

Este módulo é uma "extensão" do servidor: o `tuya_dash` não sabe dele, quem
chama é o roteador (`handle(action, query, body, bundle)`). O segredo chega
sempre no `bundle` da requisição — nada é guardado aqui.

O que foi testado AO VIVO contra o gateway móvel (a1.tuyaus.com, et=3,
assinatura já pronta em `tuya_mobile`) e portanto ENTRA no código:

  m.life.home.space.list                 v1.0  -> home(s) da conta
  m.life.app.home.device.hide.list      v1.0  -> devices ocultos do home
  smartlife.m.app.config.unit.transfer.list v1.0 -> tabela de conversão °C/°F
  m.life.app.server.list                v1.0  -> região -> servidor
  smartlife.m.country.list.international v1.0 -> 231 países
  smartlife.m.location.extend.list      v1.0  -> flag "casa padrão" por gid

O que foi testado e NÃO entrou (nada de endpoint morto no caminho quente):

  m.energy.home.device.list             v1.0-3.0 -> REMOTE_API_PARAM_ALL_INPUT_LOSS
                                        (toda variação de payload testada;
                                         por isso a energia vem dos DPS)
  m.life.app.smart.local.device.list    v1.1     -> REMOTE_API_PARAM_ALL_INPUT_LOSS
  smartlife.m.app.dynamic.config.get    1.0-5.0  -> API_OR_API_VERSION_WRONG
  m.life.app.desktop.adorn.query        1.0-1.3  -> API_OR_API_VERSION_WRONG
  m.life.location.get                   1.0-4.0  -> API_OR_API_VERSION_WRONG
  m.life.health.cloud.location.list     1.0-4.0  -> API_OR_API_VERSION_WRONG

Pegadinha que custou tempo: o gateway só aceita parâmetros de topo como
STRING. `{"gid": 91996475}` (int) dá `REMOTE_API_PARAM_ALL_INPUT_LOSS`, e
`{"gid": "91996475"}` funciona. Tudo abaixo manda string.

Unidades: o app NÃO expõe preferência de unidade do usuário em nenhuma das
APIs capturadas. O que existe é a tabela de conversão de temperatura e a
lista de países/regiões. Preferência de distância e de energia/peso não vem
de lugar nenhum — daí `not_returned` no payload, em vez de um palpite.
"""

from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import tuya_mobile as tm

SLUG = "energy"

# --- APIs testadas ao vivo ----------------------------------------------------
API_HOME_LIST = "m.life.home.space.list"                       # v1.0
API_HIDE = "m.life.app.home.device.hide.list"                 # v1.0
API_UNIT_TRANSFER = "smartlife.m.app.config.unit.transfer.list"  # v1.0
API_SERVER_LIST = "m.life.app.server.list"                    # v1.0
API_COUNTRY_LIST = "smartlife.m.country.list.international"   # v1.0
API_LOCATION_EXT = "smartlife.m.location.extend.list"          # v1.0

V_HOME = "1.0"
V_HIDE = "1.0"
V_UNIT = "1.0"
V_SERVER = "1.0"
V_COUNTRY = "1.0"
V_LOCATION = "1.0"

# Endpoints capturados do app real que responderam erro. Ficam aqui apenas
# como registro do que foi tentado — `handle()` nunca os chama.
TRIED_AND_REJECTED = (
    {"api": "m.energy.home.device.list", "versions": "1.0/2.0/3.0",
     "error": "REMOTE_API_PARAM_ALL_INPUT_LOSS"},
    {"api": "m.life.app.smart.local.device.list", "versions": "1.1",
     "error": "REMOTE_API_PARAM_ALL_INPUT_LOSS"},
    {"api": "smartlife.m.app.dynamic.config.get", "versions": "1.0-5.0",
     "error": "API_OR_API_VERSION_WRONG"},
    {"api": "m.life.app.desktop.adorn.query", "versions": "1.0-1.3",
     "error": "API_OR_API_VERSION_WRONG"},
    {"api": "m.life.location.get", "versions": "1.0-4.0",
     "error": "API_OR_API_VERSION_WRONG"},
    {"api": "m.life.health.cloud.location.list", "versions": "1.0-4.0",
     "error": "API_OR_API_VERSION_WRONG"},
)

# Só tomadas reportam DPS 18/19/20 (corrente/potência/tensão).
ENERGY_KIND = "plug"
STATUS_WORKERS = 8
CALL_TIMEOUT = 20


def _sess(bundle):
    return tm.session_from_cloud((bundle or {}).get("cloud") or {})


def _call(action: str, payload: dict, session: tuple, version: str):
    sid, ecode, url = session
    if not ecode:
        raise tm.GatewayError("bundle sem accessToken: refaça o login")
    return tm.call(action, payload, sid=sid, ecode=ecode, endpoint=url,
                   version=version, timeout=CALL_TIMEOUT)


# --- cache curto das respostas estáticas --------------------------------------
# A tabela de conversão e a lista de países não mudam; não faz sentido pedir
# ao gateway a cada reload do painel. 10 min é o TTL.
_TTL = 600.0
_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()


def _cached(key: str, produce):
    now = time.time()
    with _lock:
        hit = _cache.get(key)
    if hit and now - hit[0] < _TTL:
        return hit[1]
    value = produce()
    with _lock:
        _cache[key] = (now, value)
    return value


# --- normalizadores -----------------------------------------------------------
def _as_str(value: Any) -> str:
    """gid/devId chegam como int no app; o gateway só aceita string."""
    if value is None or isinstance(value, (dict, list)):
        return ""
    return str(value)


def _homes(session) -> list[dict]:
    """[{gid, name, ...}] de `m.life.home.space.list` v1.0."""
    out: list[dict] = []
    try:
        result = _call(API_HOME_LIST, {}, session, V_HOME)
    except tm.GatewayError:
        return out
    for node in tm._walk(result):
        gid = node.get("gid") or node.get("groupId")
        if not gid or node.get("name") is None:
            continue
        out.append({
            "gid": _as_str(gid),
            "name": str(node.get("name") or ""),
            "homeMode": node.get("homeMode"),
            "status": node.get("status"),
        })
    seen: set[str] = set()
    return [h for h in out if not (h["gid"] in seen or seen.add(h["gid"]))]


def _first_home(session) -> dict:
    homes = _homes(session)
    return homes[0] if homes else {}


# --- 1. energia ---------------------------------------------------------------
def _dps_energy(bundle: dict, query: dict) -> dict:
    """
    Energia por tomada, lida dos DPS que o próprio backend já usa.

    `m.energy.home.device.list` não serve (REMOTE_API_PARAM_ALL_INPUT_LOSS em
    toda variação testada), então o que existe é leitura instantânea, não
    histórico: `potencia_w` é a potência AGORA, não kWh accumulado.
    """
    try:
        import tuya_dash  # importado tarde: sem tinytuya o resto ainda vive
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"tuya_dash indisponível: {exc}"[:180],
                "devices": [], "total_w": 0.0, "reporting": 0}

    try:
        all_devices = tuya_dash.devices_list(bundle)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)[:180],
                "devices": [], "total_w": 0.0, "reporting": 0}

    plugs = [d for d in all_devices if d.get("kind") == ENERGY_KIND]
    fast = _as_str((query or {}).get("fast")) in ("1", "true", "True")

    def one(d: dict) -> dict:
        row = {
            "id": str(d.get("id") or ""),
            "name": str(d.get("name") or ""),
            "kind": d.get("kind"),
            "ip": d.get("ip") or None,
            "local": bool(d.get("local")),
            "remote": bool(d.get("remote")),
            "energy": {},
            "error": None,
        }
        if fast or not (row["local"] or row["remote"]):
            row["error"] = "sem leitura" if not fast else None
            return row
        try:
            st = tuya_dash.api_status(row["id"], d, bundle)
            row["energy"] = st.get("energy") or {}
            if not st.get("ok"):
                row["error"] = str(st.get("error") or "sem resposta")[:120]
        except Exception as exc:  # noqa: BLE001
            row["error"] = str(exc)[:120]
        return row

    with ThreadPoolExecutor(max_workers=STATUS_WORKERS) as ex:
        rows = list(ex.map(one, plugs))
    rows.sort(key=lambda r: -(float(r["energy"].get("potencia_w") or 0)))

    def num(row: dict, field: str) -> float:
        value = (row.get("energy") or {}).get(field)
        return float(value) if isinstance(value, (int, float)) else 0.0

    reporting = sum(1 for r in rows if r["energy"])
    return {
        "ok": True,
        "error": None,
        "metric": "potencia_w",
        "unit": "W",
        "kwh": None,
        "total_w": round(sum(num(r, "potencia_w") for r in rows), 1),
        "total_v": round(max((num(r, "tensao_v") for r in rows), default=0.0), 1),
        "reporting": reporting,
        "devices": len(rows),
        "rows": rows,
        "at": int(time.time() * 1000),
    }


def _summary(query: dict, bundle: dict) -> tuple[int, dict]:
    session = _sess(bundle)
    homes = _homes(session)
    data = _dps_energy(bundle, query)
    if not data.get("ok"):
        return 200, {"ok": False, "homes": homes, **data}
    return 200, {
        "ok": True,
        "homes": homes,
        "source": "dps",
        "source_note": (
            "m.energy.home.device.list devolve REMOTE_API_PARAM_ALL_INPUT_LOSS "
            "em toda variação de payload testada; a energia abaixo é a leitura "
            "instantânea dos DPS 18/19/20 (corrente/potência/tensão), não "
            "histórico em kWh."
        ),
        "source_rejected": [t for t in TRIED_AND_REJECTED
                            if t["api"] == "m.energy.home.device.list"],
        **data,
    }


# --- 2. unidades --------------------------------------------------------------
def _units(bundle: dict) -> tuple[int, dict]:
    session = _sess(bundle)

    def transfer():
        return _call(API_UNIT_TRANSFER, {}, session, V_UNIT)

    def servers():
        return _call(API_SERVER_LIST, {}, session, V_SERVER)

    def countries():
        return _call(API_COUNTRY_LIST, {}, session, V_COUNTRY)

    def location_ext():
        return _call(API_LOCATION_EXT, {}, session, V_LOCATION)

    errors: list[str] = []
    # a chave leva o uid: trocar de conta não pode servir a tabela do outro
    uid = str((bundle or {}).get("cloud", {}).get("uid") or "anon")

    def safe(label: str, fn):
        try:
            return _cached(f"{uid}:{label}", fn)
        except tm.GatewayError as exc:
            errors.append(f"{label}: {exc}"[:180])
            return None
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{label}: {exc}"[:180])
            return None

    unit_raw = safe("unit_transfer", transfer)
    server_raw = safe("server_list", servers)
    country_raw = safe("country_list", countries)
    location_raw = safe("location_ext", location_ext)

    # `result` de temperature é a lista de regras de conversão que o app usa.
    temperature: list[dict] = []
    if isinstance(unit_raw, dict):
        for node in tm._walk(unit_raw):
            if not isinstance(node.get("srcUnits"), list):
                continue
            temperature.append({
                "from": node.get("srcUnits") or [],
                "to": node.get("dstUnits") or [],
                "point": node.get("point"),
                "step": node.get("step"),
                "upperRound": node.get("upperRound"),
                "rules": [{"action": r.get("action"), "value": r.get("value")}
                          for r in (node.get("rules") or [])
                          if isinstance(r, dict)],
            })

    # região -> servidor: o bundle diz "us-west", o gateway diz WE = Server 7.
    region_alias: list[dict] = []
    if isinstance(server_raw, dict):
        for node in tm._walk(server_raw):
            for item in node.get("regionIndexList") or []:
                if isinstance(item, dict) and item.get("region"):
                    region_alias.append({"region": str(item.get("region")),
                                         "alias": item.get("regionAlias")})

    country_list: list[dict] = []
    if isinstance(country_raw, dict):
        for node in tm._walk(country_raw):
            for item in node.get("result") or []:
                if isinstance(item, dict) and item.get("a"):
                    country_list.append({"code2": str(item.get("a")),
                                         "code3": item.get("iso3"),
                                         "name": item.get("n"),
                                         "calling": item.get("c"),
                                         "continent": item.get("continent")})
            break
    if not country_list and isinstance(country_raw, list):
        for item in country_raw:
            if isinstance(item, dict) and item.get("a"):
                country_list.append({"code2": str(item.get("a")),
                                     "code3": item.get("iso3"),
                                     "name": item.get("n"),
                                     "calling": item.get("c"),
                                     "continent": item.get("continent")})

    home_flag: dict[str, str] = {}
    if isinstance(location_raw, dict):
        for node in tm._walk(location_raw):
            for gid, meta in (node or {}).items():
                if isinstance(meta, dict) and "defaultHome" in meta:
                    home_flag[str(gid)] = str(meta.get("defaultHome"))

    account_region = str((bundle or {}).get("cloud", {}).get("region") or "")
    alias = next((r for r in region_alias
                  if account_region and account_region.upper().startswith(r["region"])),
                 None)

    return 200, {
        "ok": True,
        "errors": errors,
        "temperature": {
            "available": bool(temperature),
            "source": f"{API_UNIT_TRANSFER} v{V_UNIT}",
            "note": ("Regras de conversão que o app aplica. A preferência do "
                     "usuário (°C ou °F) NÃO vem desta API e não é exposta "
                     "por nenhuma das capturadas."),
            "rules": temperature,
        },
        "distance": {
            "available": False,
            "value": None,
            "note": ("smartlife.m.app.dynamic.config.get devolve "
                     "API_OR_API_VERSION_WRONG em 1.0-5.0: nenhuma API "
                     "capturada devolve preferência de distância."),
        },
        "energy_weight": {
            "available": False,
            "value": None,
            "note": ("mesma API de config dinâmica: nada devolve unidade de "
                     "energia/peso. A única unidade de energia medida aqui "
                     "vem dos DPS, em W."),
        },
        "not_returned": ["distance", "energy_weight", "temperature_preference"],
        "region": {
            "account": account_region,
            "alias": alias,
            "list": region_alias,
        },
        "countries": {"count": len(country_list), "list": country_list},
        "location_ext": home_flag,
    }


# --- 3. devices ocultos ------------------------------------------------------
def _hidden(bundle: dict) -> tuple[int, dict]:
    session = _sess(bundle)
    homes = _homes(session)
    errors: list[str] = []

    raw: list[dict] = []
    for home in homes:
        gid = home["gid"]
        try:
            # string, e string: int aqui dá REMOTE_API_PARAM_ALL_INPUT_LOSS
            res = _call(API_HIDE, {"gid": gid, "homeId": gid}, session, V_HIDE)
        except tm.GatewayError as exc:
            errors.append(f"{API_HIDE} {gid}: {exc}"[:180])
            continue
        for node in tm._walk(res):
            if isinstance(node.get("bizId"), (str, int)):
                raw.append({"bizId": str(node["bizId"]),
                            "bizType": node.get("bizType"),
                            "gid": gid,
                            "home": home["name"]})

    # a API devolve SÓ bizId/bizType — o nome vem das chaves do bundle
    keys = (bundle or {}).get("keys") or {}
    rows = []
    for item in raw:
        key = keys.get(item["bizId"]) or {}
        rows.append({
            "id": item["bizId"],
            "bizType": item["bizType"],
            "gid": item["gid"],
            "home": item["home"],
            # nome é do bundle, não da API: dizemos isso no payload
            "name": key.get("name") or "",
            "name_from": "bundle" if key.get("name") else "none",
            "known": bool(key),
            "ip": key.get("ip") or None,
        })

    return 200, {
        "ok": True,
        "errors": errors,
        "homes": homes,
        "count": len(rows),
        "devices": rows,
        "note": (f"{API_HIDE} v{V_HIDE} devolve apenas bizId/bizType. "
                 "O nome do device vem do cofre de chaves do bundle."),
    }


# --- contrato -----------------------------------------------------------------
def handle(action: str, query: dict, body: dict, bundle: dict) -> tuple[int, dict]:
    """Roteia `action` e nunca deixa exceção escapar."""
    query = query if isinstance(query, dict) else {}
    body = body if isinstance(body, dict) else {}
    bundle = bundle if isinstance(bundle, dict) else {}
    try:
        if not (bundle.get("cloud") or {}).get("accessToken"):
            return 400, {"ok": False,
                         "error": "bundle sem sessão: entre na conta primeiro"}
        if action == "summary":
            return _summary(query, bundle)
        if action == "units":
            return _units(bundle)
        if action == "hidden":
            return _hidden(bundle)
        return 404, {"ok": False,
                     "error": f"ação desconhecida: {action}",
                     "actions": ["summary", "units", "hidden"]}
    except tm.GatewayError as exc:
        return 502, {"ok": False, "error": str(exc)[:300]}
    except Exception as exc:  # noqa: BLE001
        return 500, {"error": str(exc)[:300]}
