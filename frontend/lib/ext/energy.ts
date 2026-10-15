"use client";

/**
 * ENERGIA / UNIDADES / INVENTÁRIO — cliente do backend `ext_energy`.
 *
 * O segredo (sessão da conta) continua viajando no header `X-Nebula-Bundle`,
 * igual a `lib/api.ts`. Nada é guardado aqui.
 *
 * Os tipos abaixo ESPELHAM a resposta real, testada ao vivo contra o gateway
 * móvel. Em especial:
 *   - `metric` é SEMPRE "potencia_w" e `unit` "W": `m.energy.home.device.list`
 *     responde `REMOTE_API_PARAM_ALL_INPUT_LOSS` em toda variação de payload
 *     testada, então não existe histórico em kWh vindo da nuvem. `kwh` fica
 *     `null` de propósito — a API não devolveu.
 *   - a lista de ocultos traz `bizId`/`bizType` crus e o nome vem do bundle
 *     (`name_from` diz de onde).
 */

import { API_BASE } from "../api";
import { bundleHeader } from "../bundle";

/** Caminho do módulo `ext_energy` (SLUG = "energy") no roteador do backend. */
export const ENERGY_PATH = "/api/ext/energy";

/* ---------------------------------------------------------------- energia -- */

export interface DpsEnergy {
  /** DPS 20 / 10 — volts. */
  tensao_v?: number;
  /** DPS 18 — miliampere. */
  corrente_ma?: number;
  /** DPS 19 / 10 — watts, POTÊNCIA INSTANTÂNEA (não kWh). */
  potencia_w?: number;
}

export interface EnergyRow {
  id: string;
  name: string;
  kind: string | null;
  ip: string | null;
  local: boolean;
  remote: boolean;
  energy: DpsEnergy;
  error: string | null;
}

export interface HomeRef {
  gid: string;
  name: string;
  homeMode?: number | null;
  status?: boolean | null;
}

/** Uma API rejeitada fica registrada aqui — o painel mostra o porquê. */
export interface RejectedApi {
  api: string;
  versions: string;
  error: string;
}

export interface EnergySummary {
  ok: boolean;
  error?: string;
  homes: HomeRef[];
  source: "dps";
  source_note: string;
  source_rejected: RejectedApi[];
  /** nome real do campo medido pelo backend */
  metric: string;
  unit: string;
  /** null: nenhuma API devolveu consumo acumulado */
  kwh: number | null;
  total_w: number;
  total_v: number;
  /** tomadas que devolveram leitura */
  reporting: number;
  devices: number;
  rows: EnergyRow[];
  at: number;
}

/* ---------------------------------------------------------------- unidades -- */

export interface TempRule {
  action: string | null;
  value: string | null;
}

export interface TempConversion {
  from: string[];
  to: string[];
  point: number | null;
  step: number | null;
  upperRound: boolean | null;
  rules: TempRule[];
}

export interface TemperatureUnits {
  /** true só se a API de fato devolveu as regras */
  available: boolean;
  source: string;
  note: string;
  rules: TempConversion[];
}

/** Slots que o app pede e a nuvem não devolve: ficam `null`, nunca adivinhados. */
export interface UnavailableUnit {
  available: false;
  value: null;
  note: string;
}

export interface RegionAlias {
  region: string;
  alias: string | null;
}

export interface Units {
  ok: boolean;
  errors: string[];
  temperature: TemperatureUnits;
  distance: UnavailableUnit;
  energy_weight: UnavailableUnit;
  /** o que nenhuma das APIs capturadas devolveu */
  not_returned: string[];
  region: {
    account: string;
    alias: RegionAlias | null;
    list: RegionAlias[];
  };
  countries: {
    count: number;
    list: {
      code2: string;
      code3: string | null;
      name: string | null;
      calling: string | null;
      continent: string | null;
    }[];
  };
  /** gid -> flag "casa padrão" */
  location_ext: Record<string, string>;
}

/* ------------------------------------------------------------- inventário -- */

/** A API devolve SÓ isto; `name` vem do cofre de chaves do bundle. */
export interface HiddenDevice {
  id: string;
  bizType: number | null;
  gid: string;
  home: string;
  name: string;
  name_from: "bundle" | "none";
  known: boolean;
  ip: string | null;
}

export interface HiddenList {
  ok: boolean;
  errors: string[];
  homes: HomeRef[];
  count: number;
  devices: HiddenDevice[];
  note: string;
}

/* --------------------------------------------------------------- transporte */

async function call<T>(action: string): Promise<T> {
  const q = new URLSearchParams({ action });
  const r = await fetch(`${API_BASE}${ENERGY_PATH}?${q}`, {
    headers: bundleHeader(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  if (j?.ok === false && j?.error) throw new Error(j.error);
  return j as T;
}

export const extEnergy = {
  summary: () => call<EnergySummary>("summary"),
  units: () => call<Units>("units"),
  hidden: () => call<HiddenList>("hidden"),
};

/** Watts legíveis: o total real vem em décimos. */
export const fmtW = (w: number | null | undefined) =>
  w === null || w === undefined || !Number.isFinite(w)
    ? "—"
    : `${w.toFixed(1).replace(/\.0$/, "")} W`;
