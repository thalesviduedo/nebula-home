"""
CENAS / AUTOMAÇÕES / REGRAS DE LUZ / GEOFFENCE — lido (e disparado) no gateway móvel.

Este painel é o que o app Tuya Smart mostra na aba "Cenas": as cenas manuais, as
automações, o que cada uma dispara e o botão de executar. Tudo sai de
`tuya_mobile`, a mesma rota assinada que o app usa.

**O que a API do app realmente devolve (medido ao vivo, conta de teste):**

    thing.m.linkage.rule.query          v1.0   lista de cenas + automações
    thing.m.linkage.rule.query.count    v1.0   {sceneCount, automationCount, limites}
    thing.m.linkage.rule.detail.find    v1.0   uma regra (condições, sem ações)
    thing.m.linkage.rule.trigger        v1.0   EXECUTAR uma cena — {"result": true}

    smartlife.m.linkage.light.list      v1.0   automações de luz (vazio nesta conta)
    m.light.rule.preset.creatable.check v2.0   bool: pode criar preset de luz

    smartlife.m.linkage.fence.query     v2.0   cercas (geofence)
    smartlife.m.device.geofence.list.by.uid v1.0 cercas por dispositivo
    m.message.device.alarm.nodisturb.list v3.0  horários de não perturbe
    m.life.location.get                 v3.4   casa com lat/lon

**Duas armadilhas reais deste gateway, que custaram a maior parte do trabalho:**

1. A família `thing.m.linkage.*` lê o `gid` do **formulário** (a query string da
   rota), não do corpo cifrado. Mandar `gid` só no `postData` dá
   `IS_BLANK / gid Blank`, ou — pior, porque parece sucesso — devolve `[]` em
   vez da lista. Por isso `_call_form`, que recompõe a mesma assinatura do
   `tuya_mobile` (`derive_key`/`encrypt_body`/`canonical_string`/`sign` — nada
   de cripto reimplementado) acrescentando campos ao formulário. `gid` não está
   na whitelist de assinatura, então assiná-lo ou não dá no mesmo.

2. A família `m.scene.*` / `m.light.*` do app responde
   `REMOTE_API_PARAM_ALL_INPUT_LOSS` para **toda** payload plausível (gid só,
   gid+uid, gid+ruleIds, ruleIds como lista ou string, page/pageIndex, tudo no
   formulário, `et=0.0.1` em vez de `et=3`, gid inteiro). A rota existe
   (v1.0 é a única versão que não dá `API_OR_API_VERSION_WRONG`), mas o serviço
   remoto nunca enxerga os parâmetros com esta sessão. São APIs capturadas do
   app e **testadas ao vivo**: por isso `m.scene.rule.simple.query`,
   `m.scene.rule.delay.time`, `m.scene.recommend.dev.list`,
   `m.scene.homepage.rule.list`, `m.light.rule.query`,
   `m.light.detail.rule.query`, `m.light.family.dg.group.id.list` e
   `m.light.biz.property.get` NÃO entram no código. Quem cumpre o papel delas
   é a família `thing.m.linkage.rule.*`, a mesma que o app usa para executar.

**Limite honesto do inventário:** o caminho de leitura do gateway devolve as
condições (gatilho) mas **descarta `actions`** — os dispositivos que a cena
aciona. Quem tem esse detalhe é o app, que o guarda no banco local depois de ler
pela família `m.scene.*`. O painel mostra o que a API entrega de fato: nome, id,
ligado/desligado, gatilho/horário, cômodos, ícones e os passos `delay`
(esses vêm). Não inventa lista de dispositivos.

Nenhum segredo sai daqui: as ações traziam `executorProperty` com os pulsos IR
completos na resposta antiga; onde aparecer, só o tipo e o rótulo da tecla.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid
from typing import Any

import requests

import tuya_mobile as tm

SLUG = "scenes"

API_HOME = tm.API_HOME_LIST
API_RULE_LIST = "thing.m.linkage.rule.query"
API_RULE_COUNT = "thing.m.linkage.rule.query.count"
API_RULE_DETAIL = "thing.m.linkage.rule.detail.find"
API_RULE_TRIGGER = "thing.m.linkage.rule.trigger"
API_LIGHT_LINKAGE = "smartlife.m.linkage.light.list"
API_LIGHT_PRESET = "m.light.rule.preset.creatable.check"
API_FENCE = "smartlife.m.linkage.fence.query"
API_GEOFENCE_DEV = "smartlife.m.device.geofence.list.by.uid"
API_NODISTURB = "m.message.device.alarm.nodisturb.list"
API_LOCATION = "m.life.location.get"

VER_HOME = "1.0"
VER_RULE = "1.0"
VER_RULE_COUNT = "1.0"
VER_RULE_DETAIL = "1.0"
VER_TRIGGER = "1.0"
VER_LIGHT_LINKAGE = "1.0"
VER_LIGHT_PRESET = "2.0"
VER_FENCE = "2.0"
VER_GEOFENCE_DEV = "1.0"
VER_NODISTURB = "3.0"
VER_LOCATION = "3.4"

_ACTIONS = ("list", "lights", "geofence", "detail", "run")

# o gateway é o mesmo servidor que o app: cache curto evita martelar a conta
_TTL = {"list": 60.0, "lights": 90.0, "geofence": 90.0, "detail": 30.0}
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()

#Tuya: `loops` são 7 caracteres, domingo primeiro, '1' = ativo.
_WEEKDAYS = ("dom", "seg", "ter", "qua", "qui", "sex", "sáb")

# rótulos dos `actionExecutor` que a API de leitura devolve
_EXECUTOR = {
    "delay": "aguardar",
    "toggle": "alternar",
    "dpIssue": "comandar DP",
    "irIssueVii": "enviar IR",
}


def _sess(bundle: dict) -> tuple[str, str, str]:
    return tm.session_from_cloud((bundle or {}).get("cloud") or {})


def _owner(bundle: dict) -> str:
    """
    De quem é este cache. O backend é sem estado e duas contas podem chamar no
    mesmo processo: sem isto, o painel de uma mostraria a casa da outra.
    """
    cloud = (bundle or {}).get("cloud") or {}
    token = str(cloud.get("accessToken") or "")
    who = cloud.get("uid") or cloud.get("email") or "anônimo"
    return f"{who}:{hashlib.sha256(token.encode()).hexdigest()[:12]}"


# --- transporte ---------------------------------------------------------------
def _signed(action: str, payload: dict, version: str, sid: str, ecode: str,
            url: str, session, form_extra: dict | None = None) -> Any:
    """
    Mesma assinatura do `tuya_mobile.call`, porém com a possibilidade de pôr
    campos no formulário da rota (é assim que a família `thing.m.linkage.*`
    recebe o `gid`). Nenhuma cripto é reimplementada: as primitivas do
    `tuya_mobile` é que fazem o trabalho.
    """
    request_id = str(uuid.uuid4())
    key = tm.derive_key(request_id, ecode or None)
    form = {
        "a": action,
        "v": version,
        "clientId": tm.CLIENT_ID,
        "deviceId": tm.DEVICE_ID,
        "appVersion": tm.APP_VERSION,
        "appRnVersion": tm.APP_RN_VERSION,
        "sdkVersion": tm.SDK_VERSION,
        "deviceCoreVersion": tm.DEVICE_CORE_VERSION,
        "lang": tm.LANG,
        "os": "Android",
        "osSystem": tm.OS_SYSTEM,
        "platform": tm.PLATFORM,
        "channel": tm.CHANNEL,
        "ttid": tm.TTID,
        "timeZoneId": tm.TIMEZONE,
        "cp": "gzip",
        "nd": "1",
        "et": "3",
        "chKey": tm.channel_key(),
        "time": str(int(time.time())),
        "requestId": request_id,
        "postData": tm.encrypt_body(key, payload),
        "bizData": "{}",
    }
    if sid:
        form["sid"] = sid
    form.update(form_extra or {})
    # `gid` não está na whitelist de assinatura: entra no formulário sem
    # mexer na string canônica, exatamente como o app faz.
    form["sign"] = tm.sign(tm.canonical_string(form))

    http = session or requests
    try:
        response = http.post(url, data=form, timeout=20,
                             headers={"User-Agent": f"TY/{tm.APP_VERSION}"})
        envelope = response.json()
    except requests.RequestException as exc:
        raise tm.GatewayError(f"rede falhou em {url}: {exc}") from exc
    except ValueError as exc:
        raise tm.GatewayError(f"resposta não-JSON de {url}") from exc

    if "result" not in envelope:
        code = str(envelope.get("errorCode") or "")
        msg = str(envelope.get("errorMsg") or envelope.get("msg") or "")
        if code == tm.ERR_BAD_ROUTE:
            raise tm.GatewayError(f"{action}: {code} — rota/versão inválida")
        raise tm.GatewayError(f"{action}: {code or 'sem código'} {msg}"[:200])
    return tm.decrypt_body(key, envelope["result"])


def _call(session, action: str, payload: dict, version: str, sid: str, ecode: str,
          url: str, form_extra: dict | None = None) -> tuple[Any, str | None]:
    """
    Uma chamada que nunca levanta: devolve (dados, aviso). O painel é um mapa —
    uma API que recusa não pode derrubar a tela inteira.
    """
    try:
        raw = _signed(action, payload, version, sid, ecode, url, session, form_extra)
    except tm.GatewayError as exc:
        return None, f"{action} v{version}: {str(exc)[:160]}"
    # o corpo decifrado ainda pode trazer success=false com o errorCode do servidor
    if isinstance(raw, dict) and raw.get("success") is False:
        code = str(raw.get("errorCode") or "sem código")
        msg = str(raw.get("errorMsg") or "")
        return None, f"{action} v{version}: {code} {msg}".strip()[:160]
    return _data(raw), None


def _data(raw: Any) -> Any:
    """O envelope do gateway embrulha tudo em `result`."""
    if isinstance(raw, dict) and "result" in raw and raw["result"] is not raw:
        return raw["result"]
    return raw


def _list(value: Any) -> list[dict]:
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    if isinstance(value, dict):
        return [value]
    return []


# --- helpers de apresentação --------------------------------------------------
def _weekdays(loops: Any) -> list[str]:
    """'0111110' -> ['seg','ter','qua','qui','sex','sáb'] (domingo primeiro)."""
    if not isinstance(loops, str) or len(loops) < 7:
        return []
    return [_WEEKDAYS[i] for i in range(7) if loops[i] == "1"]


def _when(expr: Any) -> dict:
    """Rótulo de horário a partir do `expr` de um timer."""
    out: dict[str, Any] = {"time": None, "days": [], "timezone": None,
                           "date": None}
    entries = expr if isinstance(expr, list) else [expr]
    for item in entries:
        if not isinstance(item, dict):
            continue
        if item.get("time"):
            out["time"] = str(item["time"])
        if item.get("timeZoneId"):
            out["timezone"] = str(item["timeZoneId"])
        if item.get("date"):
            out["date"] = str(item["date"])
        days = _weekdays(item.get("loops"))
        if days:
            out["days"] = days
    return out


def _condition(cond: dict) -> dict:
    """Um gatilho normalizado: o que dispara a automação."""
    expr = cond.get("expr")
    kind = "desconhecido"
    label = str(cond.get("exprDisplay") or "").strip()
    entity = str(cond.get("entityId") or "")
    entity_type = cond.get("entityType")
    when: dict[str, Any] = {"time": None, "days": [], "timezone": None, "date": None}

    if entity == "timer" or entity_type == 6:
        kind = "timer"
        when = _when(expr)
        if when["time"]:
            days = ", ".join(when["days"]) if when["days"] else ""
            label = f"todo dia {when['time']}" + (f" ({days})" if days else "")
    elif entity == "geo" or entity == "fence" or entity_type == 7:
        kind = "geofence"
    elif entity == "lockMember" or entity_type == 5:
        kind = "membro"
    elif entity_type == 12:
        kind = "modo_alarme"
        if not label:
            mode = ""
            if isinstance(expr, list) and expr and isinstance(expr[0], list):
                parts = [str(p) for p in expr[0]]
                mode = "desarmado" if parts[:3] == ["$mode", "==", "0"] else " ".join(parts)
            label = mode or str(cond.get("entityName") or entity)
    else:
        kind = "dispositivo" if entity else "manual"
        if not label:
            label = str(cond.get("entityName") or entity or "")

    return {
        "kind": kind,
        "label": label,
        "entity_id": entity or None,
        "entity_type": entity_type,
        "icon": str(cond.get("iconUrl") or "") or None,
        "order": cond.get("orderNum") if isinstance(cond.get("orderNum"), int) else 0,
        "when": when,
    }


def _action(action: dict, names: dict[str, str]) -> dict:
    """
    Um passo. O caminho de leitura devolve sobretudo `delay`; quando aparece
    `executorProperty` com pulsos IR, só o rótulo da tecla sai — o resto é
    segredo de comando do aparelho.
    """
    entity = str(action.get("entityId") or "")
    prop = action.get("executorProperty")
    prop = prop if isinstance(prop, dict) else {}
    label = _EXECUTOR.get(str(action.get("actionExecutor") or ""),
                          str(action.get("actionExecutor") or "ação"))
    detail = ""
    if entity == "delay":
        total = (int(prop.get("minutes") or 0) * 60) + int(prop.get("seconds") or 0)
        detail = f"{total}s"
    elif prop.get("keyName"):
        detail = f"botão {prop['keyName']}"
    elif entity:
        detail = names.get(entity, entity)
    return {
        "executor": str(action.get("actionExecutor") or ""),
        "label": label,
        "entity_id": entity or None,
        "device_name": names.get(entity) if entity and entity != "delay" else None,
        "detail": detail or None,
        "enabled": bool(action.get("enabled", True)),
        "order": action.get("orderNum") if isinstance(action.get("orderNum"), int) else 0,
    }


def _rule(raw: dict, names: dict[str, str]) -> dict:
    """Uma cena/automação como o painel mostra."""
    conditions = [_condition(c) for c in _list(raw.get("conditions"))]
    conditions.sort(key=lambda c: c["order"])
    actions = [_action(a, names) for a in _list(raw.get("actions"))]
    actions.sort(key=lambda a: a["order"])
    genre = raw.get("ruleGenre")
    timers = [c for c in conditions if c["kind"] == "timer" and c["when"]["time"]]
    schedule = None
    if timers:
        first = timers[0]["when"]
        days = ", ".join(first["days"]) if first["days"] else ""
        schedule = {
            "time": first["time"],
            "days": first["days"],
            "timezone": first["timezone"],
            "label": f"{first['time']} · {days}" if days else (first["time"] or ""),
        }
    return {
        "id": str(raw.get("id") or ""),
        "name": str(raw.get("name") or raw.get("id") or "sem nome"),
        # genre 1 = cena manual (botão do app), 2 = automação (tem gatilho)
        "kind": "automation" if genre == 2 else "scene",
        "genre": genre,
        "rule_type": raw.get("ruleType"),
        "enabled": bool(raw.get("enabled")),
        "status": bool(raw.get("status")),
        "description": str(raw.get("description") or "") or None,
        "icon": str(raw.get("coverIcon") or "") or None,
        "color": str(raw.get("displayColor") or "") or None,
        "devices": [str(d) for d in (raw.get("deviceIds") or [])],
        "device_names": [names.get(str(d), str(d)) for d in (raw.get("deviceIds") or [])],
        "rooms": [str(r) for r in (raw.get("roomIds") or [])],
        "categories": [str(c) for c in (raw.get("categorys") or [])],
        "conditions": conditions,
        "actions": actions,
        "schedule": schedule,
        "alarm": bool(raw.get("alarmIssue") or raw.get("isAlarmIssue")),
        "match": raw.get("matchType"),
        "updated": raw.get("gmtModified"),
    }


def _names(bundle: dict) -> dict[str, str]:
    """devId -> nome, tirado das chaves que já estão no bundle do navegador."""
    return {str(dev_id): str((key or {}).get("name") or dev_id)
            for dev_id, key in ((bundle or {}).get("keys") or {}).items()}


def _gids(session, sid: str, ecode: str, url: str) -> tuple[list[str], list[str]]:
    data, warn = _call(session, API_HOME, {}, VER_HOME, sid, ecode, url)
    out_g: list[str] = []
    out_u: list[str] = []
    for home in _list(data):
        gid = str(home.get("gid") or home.get("groupId") or home.get("id") or "")
        if gid and gid not in out_g:
            out_g.append(gid)
        uid = str(home.get("uid") or "")
        if uid and uid not in out_u:
            out_u.append(uid)
    if warn:
        return out_g, [warn]
    return out_g, []


# --- ação: list ---------------------------------------------------------------
def _list_action(bundle: dict, http, sid: str, ecode: str, url: str) -> dict:
    warnings: list[str] = []
    names = _names(bundle)
    gids, warns = _gids(http, sid, ecode, url)
    warnings += warns
    if not gids:
        return {"ok": False, "rules": [], "counts": {},
                "warnings": warnings or ["nenhuma casa na conta"],
                "at": int(time.time())}

    rules: list[dict] = []
    counts: dict[str, int] = {}
    seen: set[str] = set()
    for gid in gids:
        # gid no formulário: a família thing.m.linkage.* lê a query da rota
        data, warn = _call(http, API_RULE_LIST, {}, VER_RULE, sid, ecode, url,
                           form_extra={"gid": gid})
        if warn:
            warnings.append(warn)
            continue
        for raw in _list(data):
            rule = _rule(raw, names)
            if rule["id"] and rule["id"] not in seen:
                seen.add(rule["id"])
                rules.append(rule)
        counter, warn = _call(http, API_RULE_COUNT, {}, VER_RULE_COUNT,
                              sid, ecode, url, form_extra={"gid": gid})
        if warn:
            warnings.append(warn)
        elif isinstance(counter, dict):
            counts = {
                "scenes": int(counter.get("sceneCount") or 0),
                "automations": int(counter.get("automationCount") or 0),
                "scene_limit": int(counter.get("sceneLimit") or 0),
                "automation_limit": int(counter.get("automationLimit") or 0),
            }

    rules.sort(key=lambda r: (r["kind"] != "scene", r["name"].lower()))
    if not counts and rules:
        counts = {
            "scenes": sum(1 for r in rules if r["kind"] == "scene"),
            "automations": sum(1 for r in rules if r["kind"] == "automation"),
            "scene_limit": 0,
            "automation_limit": 0,
        }
    return {
        "ok": True,
        "gid": gids[0],
        "rules": rules,
        "counts": counts,
        "enabled": sum(1 for r in rules if r["enabled"]),
        "warnings": warnings,
        "at": int(time.time()),
    }


# --- ação: lights -------------------------------------------------------------
def _lights(bundle: dict, http, sid: str, ecode: str, url: str) -> dict:
    """
    Regras de iluminação. A API que responde é `smartlife.m.linkage.light.list`
    (vazia nesta conta) mais o booleano de criação de preset; as cenas de luz
    que o app guarda no banco local não têm leitura aberta no gateway — o que o
    app mostra como cena de luz aparece aqui pela lista completa de `list`.
    """
    warnings: list[str] = []
    names = _names(bundle)
    gids, warns = _gids(http, sid, ecode, url)
    warnings += warns
    if not gids:
        return {"ok": False, "linkage": [], "preset_creatable": False,
                "warnings": warnings or ["nenhuma casa na conta"],
                "at": int(time.time())}

    linkage: list[dict] = []
    preset_creatable = False
    for gid in gids:
        data, warn = _call(http, API_LIGHT_LINKAGE, {"gid": gid},
                           VER_LIGHT_LINKAGE, sid, ecode, url)
        if warn:
            warnings.append(warn)
        for raw in _list(data):
            conditions = [_condition(c) for c in _list(raw.get("conditions"))]
            actions = [_action(a, names) for a in _list(raw.get("actions"))]
            linkage.append({
                "id": str(raw.get("id") or raw.get("ruleId") or ""),
                "name": str(raw.get("name") or raw.get("id") or "sem nome"),
                "enabled": bool(raw.get("enabled")),
                "conditions": conditions,
                "actions": actions,
            })
        flag, warn = _call(http, API_LIGHT_PRESET, {"gid": gid},
                           VER_LIGHT_PRESET, sid, ecode, url)
        if warn:
            warnings.append(warn)
        else:
            preset_creatable = bool(flag)

    return {
        "ok": True,
        "gid": gids[0],
        "linkage": linkage,
        "preset_creatable": preset_creatable,
        "counts": {"linkage": len(linkage)},
        "warnings": warnings,
        "at": int(time.time()),
    }


# --- ação: geofence -----------------------------------------------------------
def _geofence(bundle: dict, http, sid: str, ecode: str, url: str) -> dict:
    """Cercas, cercas por dispositivo, não perturbe e a coordenada da casa."""
    warnings: list[str] = []
    names = _names(bundle)
    gids, warns = _gids(http, sid, ecode, url)
    warnings += warns
    uid = str((bundle or {}).get("cloud", {}).get("uid") or "")
    for node in tm._walk(_call(http, API_HOME, {}, VER_HOME, sid, ecode, url)[0] or []):
        if node.get("uid"):
            uid = str(node["uid"])
            break

    fences: list[dict] = []
    device_fences: list[dict] = []
    nodisturb: list[dict] = []
    home: dict = {}

    for gid in gids:
        data, warn = _call(http, API_FENCE, {"gid": gid, "uid": uid}, VER_FENCE,
                           sid, ecode, url)
        if warn:
            warnings.append(warn)
        for raw in _list(data):
            fences.append({
                "id": str(raw.get("id") or raw.get("fenceId") or ""),
                "name": str(raw.get("name") or raw.get("fenceName") or "cerca"),
                "enabled": bool(raw.get("enabled", True)),
                "lat": raw.get("lat"),
                "lon": raw.get("lon"),
                "radius": raw.get("radius") or raw.get("fenceRadius"),
                "uid": str(raw.get("uid") or "") or None,
                "raw_keys": sorted(str(k) for k in raw.keys())[:12],
            })

        loc, warn = _call(http, API_LOCATION, {"gid": gid}, VER_LOCATION,
                          sid, ecode, url)
        if warn:
            warnings.append(warn)
        elif isinstance(loc, dict):
            home = {
                "name": str(loc.get("name") or gid),
                "lat": loc.get("lat"),
                "lon": loc.get("lon"),
                "geo_name": str(loc.get("geoName") or "") or None,
            }

    if uid:
        data, warn = _call(http, API_GEOFENCE_DEV, {"uid": uid}, VER_GEOFENCE_DEV,
                           sid, ecode, url)
        if warn:
            warnings.append(warn)
        for raw in _list(data):
            dev_id = str(raw.get("devId") or raw.get("id") or "")
            device_fences.append({
                "device_id": dev_id or None,
                "device_name": names.get(dev_id, dev_id) if dev_id else None,
                "id": str(raw.get("id") or raw.get("fenceId") or ""),
                "name": str(raw.get("name") or "cerca"),
                "enabled": bool(raw.get("enabled", True)),
                "lat": raw.get("lat"),
                "lon": raw.get("lon"),
                "radius": raw.get("radius"),
            })
    else:
        warnings.append("sem uid na conta: cercas por dispositivo não consultadas")

    for gid in gids:
        data, warn = _call(http, API_NODISTURB, {"gid": gid}, VER_NODISTURB,
                           sid, ecode, url)
        if warn:
            warnings.append(warn)
        for raw in _list(data):
            nodisturb.append({
                "id": str(raw.get("id") or ""),
                "dev_id": str(raw.get("devId") or "") or None,
                "device_name": names.get(str(raw.get("devId") or ""), "") or None,
                "start": raw.get("startTime") or raw.get("beginTime"),
                "end": raw.get("endTime") or raw.get("finishTime"),
                "enabled": bool(raw.get("enabled", True)),
                "repeat": raw.get("repeat") or raw.get("loop"),
            })

    return {
        "ok": True,
        "gid": gids[0] if gids else None,
        "uid": uid or None,
        "home": home,
        "fences": fences,
        "device_fences": device_fences,
        "nodisturb": nodisturb,
        "counts": {
            "fences": len(fences),
            "device_fences": len(device_fences),
            "nodisturb": len(nodisturb),
        },
        "warnings": warnings,
        "at": int(time.time()),
    }


# --- ação: detail -------------------------------------------------------------
def _detail(bundle: dict, http, sid: str, ecode: str, url: str,
            rule_id: str) -> dict:
    """Uma regra pelo id. O serviço devolve as condições; `actions` vem vazio."""
    warnings: list[str] = []
    names = _names(bundle)
    gids, warns = _gids(http, sid, ecode, url)
    warnings += warns
    for gid in gids:
        data, warn = _call(http, API_RULE_DETAIL, {"ruleId": rule_id},
                           VER_RULE_DETAIL, sid, ecode, url,
                           form_extra={"gid": gid})
        if warn:
            warnings.append(warn)
            continue
        raw = data if isinstance(data, dict) else {}
        if raw.get("id"):
            return {"ok": True, "gid": gid, "rule": _rule(raw, names),
                    "warnings": warnings, "at": int(time.time())}
    return {"ok": False, "rule": None,
            "error": f"regra não encontrada: {rule_id}",
            "warnings": warnings, "at": int(time.time())}


# --- ação: run ----------------------------------------------------------------
def _run(bundle: dict, http, sid: str, ecode: str, url: str, rule_id: str) -> dict:
    """
    Executar a cena. É a mesma API que o app usa no botão do painel: ela pede
    `gid`, `ruleId` e `ruleType` no corpo cifrado e devolve `{"result": true}`.
    Com um ruleId que não existe a resposta é `PERMISSION_DENIED / No access` —
    ou seja, o gateway valida de verdade, não é um `true` de façade.
    """
    if not rule_id:
        raise tm.GatewayError("informe o ruleId da cena")
    gids, warns = _gids(http, sid, ecode, url)
    if not gids:
        raise tm.GatewayError("nenhuma casa na conta: nada a executar")
    gid = gids[0]
    raw = _signed(API_RULE_TRIGGER,
                  {"gid": gid, "ruleId": rule_id, "ruleType": 3},
                  VER_TRIGGER, sid, ecode, url, http)
    if isinstance(raw, dict) and raw.get("success") is False:
        code = str(raw.get("errorCode") or "sem código")
        msg = str(raw.get("errorMsg") or "")
        raise tm.GatewayError(f"{API_RULE_TRIGGER}: {code} {msg}".strip()[:200])
    data = _data(raw)
    return {
        "ok": bool(data),
        "triggered": data is True,
        "rule_id": rule_id,
        "gid": gid,
        "result": data,
        "at": int(time.time()),
        "warnings": warns,
    }


# --- despacho -----------------------------------------------------------------
def _build(action: str, bundle: dict, query: dict, body: dict) -> dict:
    sid, ecode, url = _sess(bundle)
    if not ecode:
        raise tm.GatewayError(
            "sem accessToken no bundle: entre na conta em Nuvem para ver cenas, "
            "automações, luz e geofence")
    src = {**(query or {}), **(body or {})}
    with requests.Session() as http:
        if action == "list":
            return _list_action(bundle, http, sid, ecode, url)
        if action == "lights":
            return _lights(bundle, http, sid, ecode, url)
        if action == "geofence":
            return _geofence(bundle, http, sid, ecode, url)
        if action == "detail":
            return _detail(bundle, http, sid, ecode, url,
                           str(src.get("rule_id") or src.get("ruleId") or ""))
        return _run(bundle, http, sid, ecode, url,
                    str(src.get("rule_id") or src.get("ruleId") or ""))


def handle(action: str, query: dict, body: dict, bundle: dict) -> tuple[int, dict]:
    """`action` é o sufixo depois de /api/ext/scenes/. Devolve (status, json)."""
    parts = [p for p in str(action or "").strip("/").split("/") if p]
    if parts and parts[0] == SLUG:  # veio o slug inteiro no caminho
        parts = parts[1:]
    name = parts[0].lower() if parts else str((query or {}).get("action") or "")
    name = name.strip().lower()
    if name not in _ACTIONS:
        return 404, {"error": f"ação desconhecida: {name or '(vazia)'}",
                     "actions": list(_ACTIONS)}

    src = {**(query or {}), **(body or {})}
    fresh = bool(src.get("fresh"))
    # `run` nunca é cacheado: disparar duas vezes é o ponto.
    slot = f"{_owner(bundle or {})}::{name}"
    if name not in ("run", "detail"):
        with _lock:
            hit = _cache.get(slot)
            if hit and not fresh and time.time() - hit[0] < _TTL[name]:
                payload = dict(hit[1])
                payload["cached"] = True
                return 200, payload

    try:
        payload = _build(name, bundle or {}, query or {}, body or {})
    except tm.GatewayError as exc:
        return 502, {"error": str(exc)[:300]}
    except Exception as exc:  # noqa: BLE001 — painel nunca derruba a página
        return 500, {"error": f"{type(exc).__name__}: {exc}"[:300]}

    if payload.get("ok") is False and payload.get("error"):
        return 404, payload
    payload["cached"] = False
    if name not in ("run", "detail"):
        with _lock:
            _cache[slot] = (time.time(), dict(payload))
    return 200, payload