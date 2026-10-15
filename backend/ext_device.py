"""
Painel de detalhes do dispositivo: schema de DPS, capacidades e firmware.

O que o app Tuya mostra numa tela de "detalhes" e que ninguém tinha
descoberto ainda é o `schema`: um JSON com TODOS os DPs do aparelho, cada um
com id, code, nome, tipo e -- o que importa -- a faixa numérica ou a lista de
opções. Ele vem embutido na resposta de `smartlife.m.device.get`, que é a
única chamada da lista que devolve o aparelho inteiro. Com isso o painel
deixa de adivinhar "DP 22 é brilho" e passa a mostrar o que o firmware
realmente declara.

Todas as chamadas aqui foram testadas ao vivo contra a conta real
(ver `/tmp/ext-device-probe.json`):

    smartlife.m.device.get                 v1.0  {devId}                  -> schema + dps + produto
    m.thing.firmware.upgrade.info.get      v1.0  {devId}                  -> módulos e versão atual
    m.thing.device.product.check.for.updates v1.0 {devId}                 -> atualizações disponíveis
    smartlife.m.device.ref.info.list       v1.0  {productIds:[pid]}       -> categoria/capability do produto
    smartlife.m.device.latest.product.warn.info v1.0 {devId}               -> avisos de produto (vazio)
    m.thing.device.low.power.connect.batch.get v1.0 {devIds:[dev]}        -> [] (só passa rede)
    m.thing.device.senior.ability.get      v1.0  {devId}                  -> {} (rota viva, resposta vazia)

Nada de segredo sai daqui: a `localKey` que o gateway devolve em
`smartlife.m.device.get` é removida antes da resposta.
"""

from __future__ import annotations

import json
from typing import Any

import tuya_mobile as tm

SLUG = "device"

# --- chamadas testadas -------------------------------------------------------
API_DEVICE_GET = "smartlife.m.device.get"                       # {devId}
API_FW_INFO = "m.thing.firmware.upgrade.info.get"               # {devId}
API_FW_CHECK = "m.thing.device.product.check.for.updates"       # {devId}
API_REF_INFO = "smartlife.m.device.ref.info.list"                # {productIds:[pid]}
API_WARN_INFO = "smartlife.m.device.latest.product.warn.info"   # {devId}
API_LOW_POWER = "m.thing.device.low.power.connect.batch.get"    # {devIds:[dev]}
API_SENIOR = "m.thing.device.senior.ability.get"                # {devId}

# A resposta do gateway é HTTP 200 mesmo quando a API de negócio falha; o
# erro vem dentro do envelope descriptografado. Sem isto, `success: false`
# passaria por sucesso.
_ENVELOPE_ERROR_KEYS = ("errorCode", "code")


def _sess(bundle: dict) -> tuple[str, str, str]:
    """(sid, ecode, endpoint) do bloco `cloud` que o navegador mandou."""
    return tm.session_from_cloud((bundle or {}).get("cloud") or {})


def _envelope_error(result: Any) -> str:
    """Texto do erro de negócio, se houver. Vazio = deu certo."""
    if not isinstance(result, dict):
        return ""
    if result.get("success") is not False and not any(
        result.get(k) for k in _ENVELOPE_ERROR_KEYS
    ):
        return ""
    code = next((result[k] for k in _ENVELOPE_ERROR_KEYS if result.get(k)), "erro")
    msg = result.get("errorMsg") or result.get("msg") or ""
    return f"{code}: {msg}".strip()[:180]


def _call(action: str, payload: dict, bundle: dict, *, version: str = "1.0"):
    """Uma chamada ao gateway. Devolve (result, erro) -- nunca levanta."""
    sid, ecode, endpoint = _sess(bundle)
    if not ecode:
        return None, "sem accessToken: refaça o login para ler os detalhes"
    try:
        result = tm.call(action, payload, sid=sid, ecode=ecode,
                         endpoint=endpoint, version=version)
    except tm.GatewayError as exc:
        return None, str(exc)[:180]
    except Exception as exc:  # noqa: BLE001
        return None, f"{type(exc).__name__}: {exc}"[:180]
    return result, _envelope_error(result)


def _first(queries: dict, *keys: str, default: Any = None) -> Any:
    for key in keys:
        value = queries.get(key)
        if value not in (None, "", {}, []):
            return value
    return default


def _dev_id(query: dict, body: dict) -> str:
    blob = {**(query or {}), **(body or {})}
    return str(_first(blob, "id", "devId", "deviceId", "device_id", default="") or "").strip()


# --- normalização do schema --------------------------------------------------
def _loads(value: Any) -> Any:
    """`schema` e `extProperties` chegam como string JSON dentro do JSON."""
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except (ValueError, TypeError):
            return value
    return value


def _dp_entry(raw: dict, dps: dict) -> dict:
    """Achata um DP do schema no formato que o painel consome."""
    prop = raw.get("property") if isinstance(raw.get("property"), dict) else {}
    kind = str(prop.get("type") or raw.get("subType") or "unknown")
    key = str(raw.get("id"))
    entry: dict[str, Any] = {
        "id": raw.get("id"),
        "code": raw.get("code") or "",
        "name": raw.get("name") or "",
        "kind": kind,
        "mode": raw.get("mode") or "",
        "icon": raw.get("iconname") or "",
        "executable": raw.get("executable"),
        "readOnly": str(raw.get("mode") or "") == "ro",
        "value": dps.get(key),
        "hasValue": key in dps,
    }
    if "range" in prop:
        entry["range"] = prop["range"]
    if "label" in prop:                      # bitmap: índice -> nome do bit
        entry["labels"] = prop["label"]
    for key in ("min", "max", "step", "scale", "unit", "maxlen"):
        if key in prop:
            entry[key] = prop[key]
    entry["property"] = prop                 # cru, para o painel não perder nada
    return entry


def _device_profile(result: dict) -> dict:
    """A parte do `smartlife.m.device.get` que serve ao painel."""
    schema = _loads(result.get("schema"))
    dps = result.get("dps") if isinstance(result.get("dps"), dict) else {}
    entries = [
        _dp_entry(dp, dps) for dp in schema
        if isinstance(dp, dict) and dp.get("id") is not None
    ] if isinstance(schema, list) else []
    entries.sort(key=lambda e: (str(e.get("id")).zfill(4)))
    # DPS que o aparelho respondeu mas o schema não declara: vale mostrar.
    declared = {str(e.get("id")) for e in entries}
    for key, value in dps.items():
        if str(key) not in declared:
            entries.append({"id": key, "code": "", "name": "", "kind": "undeclared",
                            "mode": "", "icon": "", "value": value, "hasValue": True,
                            "readOnly": True, "property": {}})
    return {
        "id": result.get("devId") or "",
        "name": result.get("name") or "",
        "productId": result.get("productId") or "",
        "category": result.get("category") or "",
        "icon": result.get("iconUrl") or result.get("icon") or "",
        "bv": result.get("bv") or "",
        "verSw": result.get("verSw") or "",
        "pv": result.get("pv") or "",
        "ability": result.get("ability"),
        "accessType": result.get("accessType"),
        "gwType": result.get("gwType") or "",
        "uiType": result.get("uiType") or "",
        "ui": result.get("ui") or "",
        "uiPhase": result.get("uiPhase") or "",
        "uuid": result.get("uuid") or "",
        "mac": result.get("mac") or "",
        "ip": result.get("ip") or "",
        "isOnline": result.get("isOnline"),
        "isActive": result.get("isActive"),
        "supportGroup": result.get("supportGroup"),
        "time": result.get("time"),
        "activeTime": result.get("activeTime"),
        "appRnVersion": result.get("appRnVersion") or "",
        "dpsCount": len(entries),
        "dps": entries,
        "schemaSource": "device" if entries else "",
        "extProperties": _loads(result.get("extProperties")) or {},
        "panelConfig": result.get("panelConfig") or {},
    }


def _profile_query(dev: str, bundle: dict) -> tuple[dict, dict]:
    """smartlife.m.device.get -- a base de tudo. Devolve (perfil, consultas)."""
    raw, err = _call(API_DEVICE_GET, {"devId": dev}, bundle)
    queries: dict[str, Any] = {"device": raw if not err else None,
                               "device_error": err or ""}
    result = raw.get("result") if isinstance(raw, dict) else None
    if not isinstance(result, dict):
        return {}, queries
    return _device_profile(result), queries


# --- ações -------------------------------------------------------------------
def _product_ref(pid: str, bundle: dict) -> tuple[dict, str]:
    """
    `smartlife.m.device.ref.info.list` para um productId.

    Traz a categoria (`wf_ble_dj`, `wnykq`...), os bits de capability/attribute
    e -- o melhor -- `shortcut.displayMsgs`, que é o rótulo que o PRÓPRIO app
    mostra ("Brightness", "Color Temp"). O `name` do schema vem em chinês;
    este é o nome legível de verdade.
    """
    raw, err = _call(API_REF_INFO, {"productIds": [pid]}, bundle)
    result = (raw.get("result") if isinstance(raw, dict) else None)
    ref = result[0] if isinstance(result, list) and result else {}
    return (ref if isinstance(ref, dict) else {}), err


def _ref_summary(ref: dict, pid: str) -> dict:
    return {
        "id": ref.get("id") or pid,
        "category": ref.get("category") or "",
        "categoryCode": ref.get("categoryCode") or "",
        "capability": ref.get("capability"),
        "attribute": ref.get("attribute"),
        "supportGroup": ref.get("supportGroup"),
        "supportSGroup": ref.get("supportSGroup"),
        "meshCategory": ref.get("meshCategory") or "",
        "uiInfo": ref.get("uiInfo") or {},
        "panelConfig": ref.get("panelConfig") or {},
        "shortcut": ref.get("shortcut") or {},
    }


def _label_dps(dps: list, ref: dict) -> list:
    """Veste cada DP com o rótulo do app e com o papel no painel principal."""
    shortcut = ref.get("shortcut") if isinstance(ref, dict) else None
    shortcut = shortcut if isinstance(shortcut, dict) else {}
    msgs = shortcut.get("displayMsgs") if isinstance(shortcut.get("displayMsgs"), dict) else {}
    display = set(shortcut.get("displayDps") or [])
    quick = set(shortcut.get("quickOpDps") or [])
    switch = shortcut.get("switchDp")
    for entry in dps:
        code = str(entry.get("code") or "")
        label = ""
        for key in (f"dp_{code}", f"quickop_dp_{code}"):
            if msgs.get(key):
                label = str(msgs[key])
                break
        if label:
            entry["label"] = label
        entry["inPanel"] = entry.get("id") in display
        entry["isQuickOp"] = entry.get("id") in quick
        entry["isSwitch"] = switch is not None and entry.get("id") == switch
    return dps


def _action_schema(dev: str, bundle: dict) -> dict:
    """O item que vale o painel inteiro: DPS com nome, tipo e faixa."""
    profile, queries = _profile_query(dev, bundle)
    out: dict[str, Any] = {"ok": True, "id": dev, **profile}
    if not profile:
        out.update({"ok": False, "error": queries.get("device_error") or
                    "o gateway não devolveu o aparelho"})
        return out

    # O schema do produto é a segunda fonte: quando o device não traz
    # (aparelho virtual, firmware antigo), o produto ainda descreve os DPs.
    pid = profile.get("productId")
    if pid:
        ref, err = _product_ref(pid, bundle)
        out["product"] = _ref_summary(ref, pid)
        product_schema = _loads((ref.get("schemaInfo") or {}).get("schema")
                                if isinstance(ref.get("schemaInfo"), dict) else None)
        if not out.get("dps") and isinstance(product_schema, list):
            out["dps"] = [_dp_entry(dp, {}) for dp in product_schema
                          if isinstance(dp, dict) and dp.get("id") is not None]
            out["schemaSource"] = "product"
        _label_dps(out.get("dps") or [], ref)
        if err:
            out["productError"] = err
    return out


def _action_ability(dev: str, bundle: dict) -> dict:
    """O que o aparelho sabe fazer: produto, DP por tipo e escrita/leitura."""
    profile, queries = _profile_query(dev, bundle)
    out: dict[str, Any] = {"ok": True, "id": dev}
    if not profile:
        out.update({"ok": False, "error": queries.get("device_error") or
                    "o gateway não devolveu o aparelho"})
        return out

    pid = profile.get("productId")
    product: dict[str, Any] = {}
    if pid:
        ref, err = _product_ref(pid, bundle)
        product = _ref_summary(ref, pid)
        _label_dps(profile.get("dps") or [], ref)
        if err:
            product["error"] = err

    senior, senior_err = _call(API_SENIOR, {"devId": dev}, bundle)
    dps = profile.get("dps") or []
    by_kind: dict[str, int] = {}
    for entry in dps:
        by_kind[entry["kind"]] = by_kind.get(entry["kind"], 0) + 1
    scenes = profile.get("extProperties", {}).get("dynamicScenes")
    if isinstance(scenes, str):
        scenes = _loads(scenes)

    out.update({
        "name": profile.get("name"),
        "productId": pid,
        "product": product,
        "senior": (senior or {}).get("result") or {} if not senior_err else {},
        "seniorError": senior_err or "",
        "deviceAbility": profile.get("ability"),
        "accessType": profile.get("accessType"),
        "gwType": profile.get("gwType"),
        "uiType": profile.get("uiType"),
        "ui": profile.get("ui"),
        "uiPhase": profile.get("uiPhase"),
        "supportGroup": profile.get("supportGroup"),
        "dpsTotal": len(dps),
        "dpsWritable": sum(1 for e in dps if not e.get("readOnly")),
        "dpsReadOnly": sum(1 for e in dps if e.get("readOnly")),
        "dpsByKind": by_kind,
        "dynamicScenes": scenes if isinstance(scenes, list) else [],
        # os DPs que o app coloca no painel principal do aparelho
        "primaryDps": [
            {"id": e["id"], "code": e.get("code", ""),
             "label": e.get("label") or e.get("name") or "",
             "kind": e.get("kind", "")}
            for e in dps if e.get("inPanel") or e.get("isQuickOp") or e.get("isSwitch")
        ],
        "switchDp": product.get("shortcut", {}).get("switchDp")
        if isinstance(product.get("shortcut"), dict) else None,
        "faultDps": product.get("shortcut", {}).get("faultDps")
        if isinstance(product.get("shortcut"), dict) else None,
    })
    return out


def _action_firmware(dev: str, bundle: dict) -> dict:
    """Versão atual, se há atualização, e os avisos de produto."""
    profile, queries = _profile_query(dev, bundle)
    out: dict[str, Any] = {"ok": True, "id": dev}

    modules, fw_err = _call(API_FW_INFO, {"devId": dev}, bundle)
    modules = (modules.get("result") if isinstance(modules, dict) else None)
    modules = modules if isinstance(modules, list) else []

    updates, upd_err = _call(API_FW_CHECK, {"devId": dev}, bundle)
    updates = (updates.get("result") if isinstance(updates, dict) else None)
    updates = updates if isinstance(updates, list) else []

    warnings, warn_err = _call(API_WARN_INFO, {"devId": dev}, bundle)
    warnings = (warnings.get("result") if isinstance(warnings, dict) else None)
    warnings = warnings if isinstance(warnings, list) else []

    # endpoint que só responde com rede dedicada: vazio = não usa
    low, low_err = _call(API_LOW_POWER, {"devIds": [dev]}, bundle)
    low = (low.get("result") if isinstance(low, dict) else None)
    low = low if isinstance(low, list) else []

    main = next((m for m in modules if m.get("type") == 0), None)
    current = (main or {}).get("currentVersion") or profile.get("verSw") or profile.get("bv") or ""
    pending = bool(updates)

    out.update({
        "name": profile.get("name"),
        "productId": profile.get("productId"),
        "current": current,
        "verSw": profile.get("verSw"),
        "bv": profile.get("bv"),
        "pv": profile.get("pv"),
        "uuid": profile.get("uuid"),
        "modules": [
            {
                "type": m.get("type"),
                "typeDesc": m.get("typeDesc") or "",
                "currentVersion": m.get("currentVersion") or "",
                "upgradeStatus": m.get("upgradeStatus"),
                "lastUpgradeTime": m.get("lastUpgradeTime"),
                "timeout": m.get("timeout"),
                "controlType": m.get("controlType"),
                "devType": m.get("devType"),
                "disableBleDirectOTA": m.get("disableBleDirectOTA"),
                "hasKey": bool(m.get("firmwareKey")),
            }
            for m in modules if isinstance(m, dict)
        ],
        "pending": pending,
        "updates": [
            {k: u.get(k) for k in ("type", "typeDesc", "currentVersion",
                                   "desc", "descUrl", "lastVersion", "upgradeStatus",
                                   "timeout", "lastUpgradeTime", "firmwareKey",
                                   "controlType", "devType", "forceUpgrade")
             if k in u}
            for u in updates if isinstance(u, dict)
        ],
        "warnings": [w for w in warnings if isinstance(w, dict)],
        "lowPower": low,
        "errors": {k: v for k, v in {
            "device": queries.get("device_error"),
            "firmware": fw_err,
            "updates": upd_err,
            "warnings": warn_err,
            "lowPower": low_err,
        }.items() if v},
    })
    return out


def _action_raw(dev: str, bundle: dict) -> dict:
    """Estado cru: DPS pela nuvem + o `smartlife.m.device.get` inteiro.

    A `localKey` vem na resposta do gateway. Ela é segredo do dono e já vive
    no bundle do navegador -- nunca volta por aqui.
    """
    out: dict[str, Any] = {"ok": True, "id": dev}
    profile, queries = _profile_query(dev, bundle)
    dps: dict[str, Any] = {}
    errors: dict[str, str] = {}
    if queries.get("device_error"):
        errors["device"] = queries["device_error"]
    else:
        errors["device"] = ""

    sid, ecode, endpoint = _sess(bundle)
    if not ecode:
        errors["dp"] = "sem accessToken: refaça o login"
    else:
        try:
            # gwId vazio dá IS_BLANK/gwIdBlank; aparelho direto usa o devId
            got = tm.call(tm.API_DP_GET, {"devId": dev, "gwId": dev}, sid=sid,
                          ecode=ecode, endpoint=endpoint, version="1.0")
            err = _envelope_error(got)
            dps = tm._dps_from(got) if not err else {}
            errors["dp"] = err
        except Exception as exc:  # noqa: BLE001
            errors["dp"] = f"{type(exc).__name__}: {exc}"[:180]

    device: dict[str, Any] = {}
    sid2, ecode2, endpoint2 = _sess(bundle)
    if ecode2:
        raw, err = _call(API_DEVICE_GET, {"devId": dev}, bundle)
        result = raw.get("result") if isinstance(raw, dict) else None
        if isinstance(result, dict):
            device = {k: v for k, v in result.items() if k != "localKey"}

    out.update({
        "dps": dps,
        "device": device,
        "profile": profile,
        "count": len(dps),
        "errors": {k: v for k, v in errors.items() if v},
    })
    if not dps and errors.get("dp"):
        out["ok"] = False
        out["error"] = errors["dp"]
    return out


_ACTIONS = {
    "schema": _action_schema,
    "ability": _action_ability,
    "firmware": _action_firmware,
    "raw": _action_raw,
}


def handle(action: str, query: dict, body: dict, bundle: dict) -> tuple[int, dict]:
    """
    Ponto de entrada do painel. `query` traz `id` (devId).

    Nunca levanta: qualquer erro vira resposta JSON.
    """
    try:
        name = str(action or query.get("action") or "schema").strip().lower()
        fn = _ACTIONS.get(name)
        if not fn:
            return 400, {"ok": False,
                         "error": f"ação desconhecida: {name or '(vazio)'}",
                         "actions": sorted(_ACTIONS)}
        dev = _dev_id(query or {}, body or {})
        if not dev:
            return 400, {"ok": False, "error": "informe id (devId) do dispositivo"}
        cloud = (bundle or {}).get("cloud") or {}
        if not cloud.get("accessToken"):
            return 200, {"ok": False, "error": "sem sessão de nuvem: entre na conta "
                                               "para ler o schema",
                         "id": dev, "needsLogin": True}
        return 200, fn(dev, bundle or {})
    except Exception as exc:  # noqa: BLE001
        return 500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:300]}