"use client";

/**
 * CASAS / CÔMODOS / GRUPOS / MALHA — cliente do backend `ext_rooms`.
 *
 * O segredo (a sessão da conta) continua viajando no header `X-Nebula-Bundle`,
 * igual a `lib/api.ts`. Nada é guardado aqui.
 *
 * Os tipos ESPELHAM a resposta real, medida ao vivo contra o gateway móvel com
 * a conta de teste. O que a Tuya devolveu nessa conta, sem enfeite:
 *
 *   - `m.life.home.space.list` v1.0 devolveu UM元素 só (a casa) e **nenhum
 *     cômodo**: a conta não tem cômodo criado no app. Por isso todo roomId
 *     cai em `NO_ROOM` ("-1") e o painel mostra um cômodo sintético chamado
 *     "Sem cômodo" — é o bucket real, não um palpite.
 *   - `m.life.my.group.device.sort.list` responde **só na v2.1** (em 1.0/2.0/
 *     2.2/3.0/4.0 dá API_OR_API_VERSION_WRONG) e traz `bizId`, `roomId` e a
 *     ordem (`displayOrder`, com `homeDisplayOrder` como reserva).
 *   - `m.life.my.group.mesh.list` responde **só na v3.1** e devolve quatro
 *     listas — `mesh`, `sigmesh`, `ble_mesh_v2`, `beaconMesh` — cada entrada
 *     sendo um gateway com nome/código/versão de malha.
 *   - `m.life.my.group.device.relation.list` responde **só na v3.2** e veio
 *     `{}`: esta conta não tem relação pai/filho nenhuma.
 *   - `smartlife.m.roomtag.list` **exige `gid`** — com corpo vazio devolve
 *     REMOTE_API_PARAM_ALL_INPUT_LOSS.
 *   - `smartlife.m.my.shared.device.list` e `...shared.device.group.list`
 *     responderam, porém com lista vazia: nada foi compartilhado com esta conta.
 *
 * Chaves de malha (localKey/networkKey) existem na resposta do gateway e são
 * descartadas no backend: aqui chega apenas `has_key`.
 */

import { API_BASE } from "../api";
import { bundleHeader } from "../bundle";

/** Caminho do módulo `ext_rooms` (SLUG = "rooms") no roteador do backend. */
export const ROOMS_PATH = "/api/ext/rooms";

/** Cômodo que a Tuya usa para device fora de qualquer cômodo. */
export const NO_ROOM = "-1";

/* ---------------------------------------------------------------- dispositivos */

/** Uma linha de device como o painel mostra: id, nome e ip de verdade. */
export interface RoomDevice {
  /** devId cru — é o mesmo id do `/api/devices`. */
  id: string;
  name: string;
  ip: string | null;
  mac: string | null;
  product_id: string | null;
  /** versão do firmware (otaInfo.otaModuleMap.*.verSw) */
  ver: string;
  virtual: boolean;
  /** true se o gateway diz que o aparelho está na nuvem agora */
  online: boolean;
  /** tem localKey no bundle = dá para comandar */
  local: boolean;
  room_id: string;
  /** posição do app; -1 quando a Tuya não manda ordem */
  order: number;
  icon: string | null;
}

export interface Room {
  room_id: string;
  name: string;
  /** rótulos de `smartlife.m.roomtag.list` (vazio nesta conta) */
  tags: string[];
  count: number;
  devices: RoomDevice[];
}

export interface Home {
  gid: string;
  name: string;
  role: number | null;
  admin: boolean;
  owner_id: string;
  rooms: Room[];
  /** total de devices da casa (somando todos os cômodos) */
  count: number;
  /** cômodos reais, sem contar o bucket "Sem cômodo" */
  rooms_count: number;
  unassigned: number;
  devices: RoomDevice[];
}

export interface HomesReply {
  ok: boolean;
  homes: Home[];
  /** API que recusou, com o errorCode literal do servidor */
  warnings: string[];
  at: number;
  cached?: boolean;
}

/* ------------------------------------------------------------ compartilhados */

export interface SharedDevice extends RoomDevice {
  /** quem compartilhou (a Tuya devolve vazio nesta conta) */
  shared_by: string | null;
  room_name: string | null;
}

export interface SharedGroup {
  id: string;
  name: string;
  room_id: string | null;
  room_name: string | null;
  shared_by: string | null;
  device_ids: string[];
  count: number;
}

export interface SharedReply {
  ok: boolean;
  devices: SharedDevice[];
  groups: SharedGroup[];
  counts: { devices: number; groups: number };
  warnings: string[];
  at: number;
  cached?: boolean;
}

/* -------------------------------------------------------------------- malha */

/** `bucket` é a lista exata do gateway; `kind` é o rótulo já traduzido. */
export interface MeshGateway {
  id: string;
  name: string;
  kind: string;
  bucket: "mesh" | "sigmesh" | "ble_mesh_v2" | "beaconMesh" | string;
  code: string;
  /** versão do protocolo de malha (pv) */
  pv: string;
  type: number | null;
  ip: string | null;
  /** existe chave no gateway — o valor NUNCA sai do backend */
  has_key: boolean;
  child_ids: string[];
  count: number;
}

/** Sub-dispositivo: o módulo que depende de uma bridge, por exemplo. */
export interface MeshRelation {
  parent_id: string;
  child_id: string;
  kind: string;
  parent_name: string;
  child_name: string;
}

export interface MeshReply {
  ok: boolean;
  gateways: MeshGateway[];
  relations: MeshRelation[];
  counts: { gateways: number; relations: number };
  warnings: string[];
  at: number;
  cached?: boolean;
}

/* --------------------------------------------------------------- transporte */

async function call<T>(action: string, fresh = false): Promise<T> {
  // o roteador aceita o sufixo no caminho e o `?action=`; mandamos os dois
  // para o painel funcionar com qualquer um dos dois.
  const q = new URLSearchParams({ action });
  if (fresh) q.set("fresh", "1");
  const r = await fetch(`${API_BASE}${ROOMS_PATH}/${action}?${q}`, {
    headers: bundleHeader(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  if (j?.ok === false && j?.error) throw new Error(j.error);
  return j as T;
}

export const extRooms = {
  homes: (fresh = false) => call<HomesReply>("homes", fresh),
  shared: (fresh = false) => call<SharedReply>("shared", fresh),
  mesh: (fresh = false) => call<MeshReply>("mesh", fresh),
};

/** Rótulo legível para os quatro buckets que o mesh.list devolve. */
export const MESH_KIND: Record<string, string> = {
  mesh: "malha",
  sigmesh: "malha assinada",
  ble_mesh_v2: "BLE mesh v2",
  beaconMesh: "beacon",
};