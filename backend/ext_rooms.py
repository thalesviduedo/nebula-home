"""
CASAS / CÔMODOS / GRUPOS / MALHA — a topologia da conta, lida do gateway móvel.

Este painel é o complemento do `/api/devices`: aquele responde "o que existe e
dá para comandar", este responde "onde cada coisa mora" — casa, cômodo, grupo,
dispositivo compartilhado por outra pessoa e a malha (bridge -> módulos).

Tudo aqui sai de `tuya_mobile.call`, a mesma rota assinada que o app Tuya
Smart usa. As versões importam e não são óbvias: cada `a` só responde na versão
em que o app o chama, e o gateway responde `API_OR_API_VERSION_WRONG` para
qualquer outra. As que valem (medidas ao vivo contra a conta de teste):

    m.life.home.space.list                 v1.0   casas (gid, nome, role, admin)
    m.life.group.room.map.get              v1.0   {rooms:[], roomGroupMap:{}}
    smartlife.m.roomtag.list               v1.0   etiquetas de cômodo (exige gid)
    m.life.my.group.device.sort.list       v2.1   bizId -> roomId + ordem
    m.life.my.group.device.list           v2.2   devId, nome, ip, produto
    smartlife.m.my.shared.device.list      v1.0   compartilhados comigo
    smartlife.m.my.shared.device.group.list v1.0  grupos compartilhados
    m.life.my.group.mesh.list              v3.1   mesh / sigmesh / ble_mesh_v2
    m.life.my.group.device.relation.list   v3.2   relação pai -> filho

Duas APIs da lista não responderam em nada e não entram no código:
`m.life.my.group.device.group.list` (API_OR_API_VERSION_WRONG em 16 versões) e
`smartlife.m.device.ref.info.list` (REMOTE_API_PARAM_ALL_INPUT_LOSS em 8
payloads diferentes). A malha de cômodos sai do próprio device.list.

Nenhum segredo sai daqui: as chaves de malha (localKey/networkKey/password)
existem na resposta do gateway mas viram apenas `has_key: true`.
"""

from __future__ import annotations

import hashlib
import threading
import time
from typing import Any

import requests

import tuya_mobile as tm

SLUG = "rooms"

API_HOME = "m.life.home.space.list"
API_ROOM_MAP = "m.life.group.room.map.get"
API_ROOM_TAG = "smartlife.m.roomtag.list"
API_DEV_SORT = "m.life.my.group.device.sort.list"
API_DEV_LIST = tm.API_DEVICE_LIST
API_SHARED_DEV = "smartlife.m.my.shared.device.list"
API_SHARED_GRP = "smartlife.m.my.shared.device.group.list"
API_MESH = "m.life.my.group.mesh.list"
API_RELATION = "m.life.my.group.device.relation.list"

VER_HOME = "1.0"
VER_ROOM_MAP = "1.0"
VER_ROOM_TAG = "1.0"
VER_DEV_SORT = "2.1"
VER_DEV_LIST = "2.2"
VER_SHARED = "1.0"
VER_MESH = "3.1"
VER_RELATION = "3.2"

# cômodo "não classificado" — é assim que a Tuya marca device fora de cômodo
NO_ROOM = "-1"
NO_ROOM_LABEL = "Sem cômodo"

_ACTIONS = ("homes", "shared", "mesh")
# o gateway é do mesmo servidor que o app: cache curto evita martelar a conta
# a cada re-render do painel.
_TTL = {"homes": 90.0, "shared": 120.0, "mesh": 180.0}
_cache: dict[str, tuple[float, dict]] = {}
_lock = threading.Lock()


def _owner(bundle: dict) -> str:
    """
    De quem é este cache. O backend é sem estado e duas contas podem chamar no
    mesmo processo: sem isto, o painel de uma mostraria a casa da outra.
    """
    cloud = (bundle or {}).get("cloud") or {}
    token = str(cloud.get("accessToken") or "")
    return f"{cloud.get('uid') or cloud.get('email') or 'anônimo'}:{hashlib.sha256(token.encode()).hexdigest()[:12]}"


def _sess(bundle: dict) -> tuple[str, str, str]:
    return tm.session_from_cloud((bundle or {}).get("cloud") or {})


# --- transporte ---------------------------------------------------------------
def _call(session, action: str, payload: dict, version: str,
          sid: str, ecode: str, url: str) -> Any:
    """
    Uma chamada que nunca levanta: devolve (dados, aviso). O painel é um mapa
    de topologia — uma API que recusa não pode derrubar a tela inteira.
    """
    try:
        raw = tm.call(action, payload, sid=sid, ecode=ecode, endpoint=url,
                      version=version, session=session)
    except tm.GatewayError as exc:
        return None, f"{action} v{version}: {str(exc)[:160]}"
    # `tm.call` só levanta quando falta `result` no envelope; o corpo decifrado
    # ainda pode trazer success=false com o errorCode do servidor.
    if isinstance(raw, dict) and raw.get("success") is False:
        code = str(raw.get("errorCode") or "sem código")
        msg = str(raw.get("errorMsg") or "")
        return None, f"{action} v{version}: {code} {msg}".strip()[:160]
    return _data(raw), None


def _data(raw: Any) -> Any:
    """O envelope do gateway embrulha tudo em `result`."""
    if isinstance(raw, dict) and isinstance(raw.get("result"), (dict, list)):
        return raw["result"]
    return raw


def _list(value: Any) -> list[dict]:
    if isinstance(value, list):
        return [v for v in value if isinstance(v, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _ids(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v) for v in value if isinstance(v, (str, int)) and str(v)]
    if isinstance(value, str) and value:
        return [value]
    return []


def _online(dev: dict) -> bool:
    if isinstance(dev.get("cloudOnline"), bool):
        return bool(dev["cloudOnline"])
    active = dev.get("activeTime")
    if isinstance(active, (int, float)) and active > 0:
        return time.time() - float(active) < 600
    return False


def _ver(dev: dict) -> str:
    ota = dev.get("otaInfo")
    if isinstance(ota, dict):
        modules = ota.get("otaModuleMap")
        if isinstance(modules, dict):
            for module in ("mcu", "wifi", "bluetooth", "zigbee"):
                entry = modules.get(module)
                if isinstance(entry, dict) and entry.get("verSw"):
                    return str(entry["verSw"])
    return str(dev.get("verSw") or "")


def _device_row(dev: dict, bundle: dict, room_id: str = "", order: int = -1) -> dict:
    """Uma linha de device para a UI — sem localKey, sempre."""
    dev_id = str(dev.get("devId") or dev.get("id") or "")
    key = (bundle.get("keys") or {}).get(dev_id) or {}
    room = room_id
    if not room:
        room = str(dev.get("roomId") if dev.get("roomId") is not None else NO_ROOM)
    return {
        "id": dev_id,
        "name": str(dev.get("name") or key.get("name") or dev_id or "sem nome"),
        "ip": str(dev.get("ip") or key.get("ip") or "") or None,
        "mac": str(dev.get("mac") or "") or None,
        "product_id": str(dev.get("productId") or "") or None,
        "ver": _ver(dev) or str(key.get("ver") or ""),
        "virtual": bool(dev.get("virtual")),
        "online": _online(dev),
        "local": bool(key.get("localKey")),   # tem chave = dá para comandar
        "room_id": room,
        "order": order,
        "icon": str(dev.get("iconUrl") or "") or None,
    }


# --- cômodos ------------------------------------------------------------------
def _rooms_of(data: Any) -> list[dict]:
    """`m.life.group.room.map.get` -> lista normalizada de cômodos."""
    rooms: list[dict] = []
    seen: set[str] = set()
    for room in _list(_data(data).get("rooms") if isinstance(data, dict) else None):
        room_id = str(room.get("roomId") or room.get("id") or "")
        if not room_id or room_id in seen:
            continue
        seen.add(room_id)
        rooms.append({
            "room_id": room_id,
            "name": str(room.get("roomName") or room.get("name") or room_id),
            "tags": [],
        })
    return rooms


def _room_group_map(data: Any) -> dict[str, list[str]]:
    """{roomId: [bizId...]} — quem a Tuya coloca dentro de cada cômodo."""
    raw = data.get("roomGroupMap") if isinstance(data, dict) else None
    out: dict[str, list[str]] = {}
    if isinstance(raw, dict):
        for room_id, members in raw.items():
            out[str(room_id)] = _ids(members)
    return out


def _tags_by_room(data: Any, gid: str) -> dict[str, list[str]]:
    """`smartlife.m.roomtag.list` -> {roomId: [rótulo...]} (vazio nesta conta)."""
    out: dict[str, list[str]] = {}
    for tag in _list(data):
        room_id = str(tag.get("roomId") or tag.get("groupId") or gid or "")
        label = str(tag.get("tagName") or tag.get("name") or tag.get("nameCn") or "")
        if room_id and label:
            out.setdefault(room_id, []).append(label)
    return out


def _room_of_device(sort_rows: Any, room_map: dict[str, list[str]],
                    gid: str) -> dict[str, str]:
    """deviceId -> roomId, cruzando a ordem do app com o mapa de cômodos."""
    out: dict[str, str] = {}
    for members in room_map.values():
        for biz in members:
            out.setdefault(str(biz), NO_ROOM)
    for row in _list(sort_rows):
        biz = str(row.get("bizId") or row.get("devId") or "")
        if not biz:
            continue
        room = str(row.get("roomId") if row.get("roomId") is not None else NO_ROOM)
        if row.get("roomId") in (None, "", NO_ROOM) and biz not in out:
            room = out.get(biz, NO_ROOM)
        out[biz] = room
    if not out:
        # sem o sort list: cai no mapa puro, senão tudo fica em "sem cômodo"
        out = {biz: room for room, members in room_map.items() for biz in members}
    return out


def _order_of(sort_rows: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    for row in _list(sort_rows):
        biz = str(row.get("bizId") or row.get("devId") or "")
        if biz:
            order = row.get("displayOrder")
            if not isinstance(order, int) or order < 0:
                order = row.get("homeDisplayOrder")
            out[biz] = order if isinstance(order, int) else -1
    return out


# --- ação: homes --------------------------------------------------------------
def _homes(bundle: dict, http, sid: str, ecode: str, url: str) -> dict:
    warnings: list[str] = []

    home_data, warn = _call(http, API_HOME, {}, VER_HOME, sid, ecode, url)
    if warn:
        warnings.append(warn)
        home_data = []

    homes: list[dict] = []
    for home in _list(home_data):
        gid = str(home.get("gid") or home.get("groupId") or home.get("id") or "")
        if not gid:
            continue
        payload = {"gid": gid}
        map_data, w = _call(http, API_ROOM_MAP, payload, VER_ROOM_MAP, sid, ecode, url)
        if w:
            warnings.append(w)
            map_data = {}
        tag_data, w = _call(http, API_ROOM_TAG, payload, VER_ROOM_TAG, sid, ecode, url)
        if w:
            warnings.append(w)
        sort_data, w = _call(http, API_DEV_SORT, payload, VER_DEV_SORT, sid, ecode, url)
        if w:
            warnings.append(w)
        dev_data, w = _call(http, API_DEV_LIST, payload, VER_DEV_LIST, sid, ecode, url)
        if w:
            warnings.append(w)

        rooms = _rooms_of(map_data)
        tags = _tags_by_room(tag_data, gid)
        room_map = _room_group_map(map_data)
        room_of = _room_of_device(sort_data, room_map, gid)
        order_of = _order_of(sort_data)

        known = {str(r["room_id"]) for r in rooms}
        for room_id in room_of.values():
            if room_id not in known:
                known.add(room_id)
                rooms.append({"room_id": room_id,
                              "name": NO_ROOM_LABEL if room_id == NO_ROOM else room_id,
                              "tags": []})
        for room in rooms:
            room["tags"] = tags.get(room["room_id"], [])

        devices: list[dict] = []
        for dev in _list(dev_data):
            dev_id = str(dev.get("devId") or dev.get("id") or "")
            if not dev_id:
                continue
            room_id = str(dev.get("roomId")) if dev.get("roomId") is not None else ""
            row = _device_row(dev, bundle, room_id or room_of.get(dev_id, NO_ROOM),
                              order_of.get(dev_id, -1))
            devices.append(row)
        devices.sort(key=lambda d: (d["room_id"], d["order"] < 0, d["order"],
                                    d["name"].lower()))

        buckets: dict[str, list[dict]] = {}
        for dev in devices:
            buckets.setdefault(dev["room_id"], []).append(dev)
        for room in rooms:
            room["devices"] = buckets.get(room["room_id"], [])
            room["count"] = len(room["devices"])

        unassigned = sum(1 for d in devices if d["room_id"] == NO_ROOM)
        homes.append({
            "gid": gid,
            "name": str(home.get("name") or gid),
            "role": home.get("role"),
            "admin": bool(home.get("admin")),
            "owner_id": str(home.get("ownerId") or ""),
            "rooms": rooms,
            "count": len(devices),
            "rooms_count": len([r for r in rooms if r["room_id"] != NO_ROOM]),
            "unassigned": unassigned,
            "devices": devices,
        })

    return {"ok": True, "homes": homes, "warnings": warnings, "at": int(time.time())}


# --- ação: shared -------------------------------------------------------------
def _shared(bundle: dict, http, sid: str, ecode: str, url: str) -> dict:
    warnings: list[str] = []

    # o app pede a lista compartilhada já classificada por cômodo
    shared_dev, w = _call(http, API_SHARED_DEV, {"roomId": NO_ROOM}, VER_SHARED,
                          sid, ecode, url)
    if w:
        warnings.append(w)
        shared_dev, w = _call(http, API_SHARED_DEV, {}, VER_SHARED, sid, ecode, url)
        if w:
            warnings.append(w)

    devices: list[dict] = []
    for dev in _list(shared_dev):
        dev_id = str(dev.get("devId") or dev.get("id") or "")
        if not dev_id:
            continue
        row = _device_row(dev, bundle)
        row["shared_by"] = str(dev.get("sharedBy") or dev.get("ownerId") or "") or None
        row["room_name"] = str(dev.get("roomName") or dev.get("roomNameCn") or "") or None
        devices.append(row)

    shared_grp, w = _call(http, API_SHARED_GRP, {"roomId": NO_ROOM}, VER_SHARED,
                          sid, ecode, url)
    if w:
        warnings.append(w)
        shared_grp, w = _call(http, API_SHARED_GRP, {}, VER_SHARED, sid, ecode, url)
        if w:
            warnings.append(w)

    groups: list[dict] = []
    for grp in _list(shared_grp):
        gid = str(grp.get("gid") or grp.get("groupId") or grp.get("id") or "")
        if not gid:
            continue
        members = _ids(grp.get("devIds") or grp.get("deviceIds") or grp.get("childIds"))
        groups.append({
            "id": gid,
            "name": str(grp.get("name") or gid),
            "room_id": str(grp.get("roomId") or "") or None,
            "room_name": str(grp.get("roomName") or "") or None,
            "shared_by": str(grp.get("sharedBy") or grp.get("ownerId") or "") or None,
            "device_ids": members,
            "count": len(members),
        })

    return {"ok": True, "devices": devices, "groups": groups,
            "counts": {"devices": len(devices), "groups": len(groups)},
            "warnings": warnings, "at": int(time.time())}


# --- ação: mesh ---------------------------------------------------------------
_MESH_BUCKETS = (("mesh", "mesh"), ("sigmesh", "sigmesh"),
                 ("ble_mesh_v2", "ble_mesh_v2"), ("beaconMesh", "beacon"))


def _mesh_gateways(data: Any, bundle: dict) -> list[dict]:
    gateways: list[dict] = []
    if not isinstance(data, dict):
        return gateways
    for bucket, kind in _MESH_BUCKETS:
        for node in _list(data.get(bucket)):
            node_id = str(node.get("id") or node.get("meshId") or node.get("code") or "")
            if not node_id:
                continue
            children = _ids(node.get("nodeIds") or node.get("devIds")
                            or node.get("subDevIds"))
            key = (bundle.get("keys") or {}).get(node_id) or {}
            gateways.append({
                "id": node_id,
                "name": str(node.get("name") or key.get("name") or node_id),
                "kind": str(node.get("kind") or kind),
                "bucket": bucket,
                "code": str(node.get("code") or ""),
                "pv": str(node.get("pv") or ""),
                "type": node.get("type"),
                "ip": str(node.get("ip") or key.get("ip") or "") or None,
                # a chave existe no gateway mas nunca sai daqui
                "has_key": bool(node.get("localKey") or node.get("networkKey")
                                or key.get("localKey")),
                "child_ids": children,
                "count": len(children),
            })
    return gateways


def _relations(data: Any, index: dict[str, dict]) -> list[dict]:
    """
    Pai -> filho. A resposta é um mapa livre; o que interessa é achar pares
    (pai, filhos) seja em `{"<id>": [filhos]}` ou em nós com parentId/childId.
    """
    known = set(index)
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()

    def add(parent: str, child: str, kind: str) -> None:
        if not parent or not child or (parent, child) in seen:
            return
        seen.add((parent, child))
        out.append({"parent_id": parent, "child_id": child, "kind": kind,
                    "parent_name": index.get(parent, {}).get("name", parent),
                    "child_name": index.get(child, {}).get("name", child)})

    for node in tm._walk(data):
        parent = str(node.get("parentId") or node.get("mainsId") or node.get("pid") or "")
        child = str(node.get("childId") or node.get("subId") or node.get("cid") or "")
        if parent and child:
            add(parent, child, str(node.get("type") or node.get("relation") or "sub"))
        for key, value in node.items():
            if key in known and isinstance(value, list):
                for kid in _ids(value):
                    add(key, kid, "sub")

    return out


def _mesh(bundle: dict, http, sid: str, ecode: str, url: str) -> dict:
    warnings: list[str] = []

    home_data, w = _call(http, API_HOME, {}, VER_HOME, sid, ecode, url)
    if w:
        warnings.append(w)
    gids = [str(h.get("gid") or h.get("groupId") or h.get("id") or "")
            for h in _list(home_data)]
    gids = [g for g in gids if g]
    if not gids:
        gids = [""]

    gateways: list[dict] = []
    relations: list[dict] = []
    index: dict[str, dict] = {}
    for gid in gids:
        mesh_data, w = _call(http, API_MESH, {"gid": gid}, VER_MESH, sid, ecode, url)
        if w:
            warnings.append(w)
        relation_data, w = _call(http, API_RELATION, {"gid": gid}, VER_RELATION,
                                 sid, ecode, url)
        if w:
            warnings.append(w)
        found = _mesh_gateways(mesh_data, bundle)
        if not any(g["id"] in index for g in found):
            gateways.extend(found)
        for node in found:
            index.setdefault(node["id"], node)

        # index dos devices da casa, para dar nome aos filhos
        dev_data, w = _call(http, API_DEV_LIST, {"gid": gid}, VER_DEV_LIST,
                            sid, ecode, url)
        if w:
            warnings.append(w)
        for dev in _list(dev_data):
            dev_id = str(dev.get("devId") or dev.get("id") or "")
            if dev_id:
                index.setdefault(dev_id, _device_row(dev, bundle))

        for rel in _relations(relation_data, index):
            if (rel["parent_id"], rel["child_id"]) not in {
                    (r["parent_id"], r["child_id"]) for r in relations}:
                relations.append(rel)

    # filhos contados por pai
    for gw in gateways:
        kids = [r["child_id"] for r in relations if r["parent_id"] == gw["id"]]
        merged = list(dict.fromkeys(gw["child_ids"] + kids))
        gw["child_ids"] = merged
        gw["count"] = len(merged)

    return {"ok": True, "gateways": gateways, "relations": relations,
            "counts": {"gateways": len(gateways), "relations": len(relations)},
            "warnings": warnings, "at": int(time.time())}


# --- despacho -----------------------------------------------------------------
def _build(action: str, bundle: dict) -> dict:
    cloud = (bundle or {}).get("cloud") or {}
    sid, ecode, url = _sess(bundle)
    if not ecode:
        raise tm.GatewayError(
            "sem accessToken no bundle: entre na conta em Nuvem para ver casas, "
            "cômodos e malha")
    with requests.Session() as http:
        if action == "homes":
            return _homes(bundle, http, sid, ecode, url)
        if action == "shared":
            return _shared(bundle, http, sid, ecode, url)
        return _mesh(bundle, http, sid, ecode, url)


def handle(action: str, query: dict, body: dict, bundle: dict) -> tuple[int, dict]:
    """`action` é o sufixo depois de /api/ext/rooms/. Devolve (status, json)."""
    parts = [p for p in str(action or "").strip("/").split("/") if p]
    if parts and parts[0] == SLUG:  # veio o slug inteiro no caminho
        parts = parts[1:]
    name = parts[0].lower() if parts else str((query or {}).get("action") or "")
    name = name.strip().lower()
    if name not in _ACTIONS:
        return 404, {"error": f"ação desconhecida: {name or '(vazia)'}",
                     "actions": list(_ACTIONS)}
    fresh = bool((query or {}).get("fresh") or (body or {}).get("fresh"))
    ttl = 0.0 if fresh else _TTL[name]
    slot = f"{_owner(bundle or {})}::{name}"

    with _lock:
        hit = _cache.get(slot)
        if hit and ttl and time.time() - hit[0] < ttl:
            payload = dict(hit[1])
            payload["cached"] = True
            return 200, payload

    try:
        payload = _build(name, bundle or {})
    except tm.GatewayError as exc:
        return 502, {"error": str(exc)[:300]}
    except Exception as exc:  # noqa: BLE001 — painel nunca derruba a página
        return 500, {"error": f"{type(exc).__name__}: {exc}"[:300]}

    payload["cached"] = False
    with _lock:
        _cache[slot] = (time.time(), dict(payload))
    return 200, payload