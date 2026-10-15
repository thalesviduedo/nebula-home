import { bundleHeader } from "../bundle";
import { API_BASE } from "../api";

/**
 * Detalhes do dispositivo: schema de DPS, capacidades e firmware.
 *
 * Tudo vem do gateway móvel (`backend/ext_device.py`). O schema é o ponto:
 * o app esconde o contrato real do firmware, e é ele que diz que o DP 22 é
 * `bright_value`, bool/value/enum, de 10 a 1000 -- sem adivinhação.
 *
 * As formas abaixo espelham a resposta REAL medida ao vivo, não o formato
 * documentação: `schema` é uma string JSON dentro do JSON, e o erro de
 * negócio vem em HTTP 200 dentro do envelope.
 */

export type DpKind = "bool" | "value" | "enum" | "string" | "raw" | "bitmap";

export interface DpEntry {
  id: number;
  code: string;
  /** nome do schema (vem em chinês no produto internacional) */
  name: string;
  /** rótulo que o próprio app mostra ("Brightness", "Color Temp") */
  label?: string;
  kind: string;
  /** rw = leitura+escrita, ro = só leitura, wr = só escrita */
  mode: string;
  icon?: string;
  executable?: boolean;
  readOnly: boolean;
  value: boolean | number | string | null;
  hasValue: boolean;
  /** opções do enum */
  range?: (string | number)[];
  /** bits do bitmap, na ordem do valor inteiro */
  labels?: string[];
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  unit?: string;
  maxlen?: number;
  property: Record<string, unknown>;
  /** o app coloca este DP no painel principal do aparelho */
  inPanel?: boolean;
  isQuickOp?: boolean;
  isSwitch?: boolean;
}

export interface ProductRef {
  id: string;
  category: string;
  categoryCode: string;
  capability: number | null;
  attribute: number | null;
  supportGroup?: boolean;
  supportSGroup?: boolean;
  meshCategory: string;
  uiInfo?: {
    id?: number;
    type?: string;
    ui?: string;
    phase?: string;
    appRnVersion?: string;
    rnFind?: boolean;
  };
  panelConfig?: Record<string, unknown>;
  shortcut?: {
    displayDps?: number[];
    quickOpDps?: number[];
    faultDps?: number[];
    switchDp?: number | null;
    displayMsgs?: Record<string, string>;
  };
  error?: string;
}

export interface SchemaResponse {
  ok: boolean;
  id: string;
  error?: string;
  needsLogin?: boolean;
  name?: string;
  productId?: string;
  category?: string;
  icon?: string;
  bv?: string;
  verSw?: string;
  pv?: string;
  ability?: number;
  accessType?: number;
  gwType?: string;
  uiType?: string;
  ui?: string;
  uiPhase?: string;
  uuid?: string;
  mac?: string;
  ip?: string;
  isOnline?: boolean;
  isActive?: boolean;
  supportGroup?: boolean;
  time?: number;
  activeTime?: number;
  appRnVersion?: string;
  dpsCount?: number;
  /** "device" = schema veio do aparelho; "product" = veio do produto */
  schemaSource?: "device" | "product" | "";
  dps: DpEntry[];
  product?: ProductRef;
  productError?: string;
  extProperties?: Record<string, unknown>;
  panelConfig?: Record<string, unknown>;
}

export interface AbilityResponse {
  ok: boolean;
  id: string;
  error?: string;
  needsLogin?: boolean;
  name?: string;
  productId?: string;
  product: ProductRef;
  /** m.thing.device.senior.ability.get responde {} nesta conta */
  senior: Record<string, unknown>;
  seniorError?: string;
  deviceAbility?: number;
  accessType?: number;
  gwType?: string;
  uiType?: string;
  ui?: string;
  uiPhase?: string;
  supportGroup?: boolean;
  dpsTotal?: number;
  dpsWritable?: number;
  dpsReadOnly?: number;
  dpsByKind?: Record<string, number>;
  dynamicScenes?: { name: string; value: string }[];
  primaryDps?: { id: number; code: string; label: string; kind: string }[];
  switchDp?: number | null;
  faultDps?: number[] | null;
}

export interface FirmwareModule {
  type: number;
  typeDesc: string;
  currentVersion: string;
  upgradeStatus: number | null;
  lastUpgradeTime: number | null;
  timeout: number | null;
  controlType: number | null;
  devType: number | null;
  disableBleDirectOTA?: boolean;
  hasKey: boolean;
}

export interface FirmwareResponse {
  ok: boolean;
  id: string;
  error?: string;
  needsLogin?: boolean;
  name?: string;
  productId?: string;
  current: string;
  verSw?: string;
  bv?: string;
  pv?: string;
  uuid?: string;
  modules: FirmwareModule[];
  /** há atualização esperando? */
  pending: boolean;
  updates: Record<string, unknown>[];
  warnings: Record<string, unknown>[];
  lowPower: unknown[];
  errors?: Record<string, string>;
}

export interface RawResponse {
  ok: boolean;
  id: string;
  error?: string;
  needsLogin?: boolean;
  dps: Record<string, unknown>;
  /** smartlife.m.device.get inteiro, sem a localKey */
  device: Record<string, unknown>;
  profile?: SchemaResponse;
  count?: number;
  errors?: Record<string, string>;
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { headers: bundleHeader() });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`);
  return body;
}

/** `action` e `id` na query: é o que o backend `ext_device.handle` espera. */
function path(action: string, id: string) {
  return `/api/ext/device?${new URLSearchParams({ action, id })}`;
}

export const deviceDetail = {
  schema: (id: string) => get<SchemaResponse>(path("schema", id)),
  ability: (id: string) => get<AbilityResponse>(path("ability", id)),
  firmware: (id: string) => get<FirmwareResponse>(path("firmware", id)),
  raw: (id: string) => get<RawResponse>(path("raw", id)),
};

export const KIND_LABEL: Record<string, string> = {
  bool: "bool",
  value: "int",
  enum: "enum",
  string: "string",
  raw: "raw",
  bitmap: "bitmap",
  undeclared: "sem schema",
  unknown: "?",
};

/** `raw` e `bitmap` são inteiros na base; os outros são texto. */
export function isNumeric(kind: string) {
  return kind === "value" || kind === "bitmap" || kind === "undeclared";
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text || "(vazio)";
}

/** O DP tem faixa? Slider/stepper só faz sentido com min/max. */
export function dpRange(dp: DpEntry) {
  const min = Number(dp.min ?? 0);
  const max = Number(dp.max ?? 0);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const step = Number(dp.step ?? 1) || 1;
  return { min, max, step };
}