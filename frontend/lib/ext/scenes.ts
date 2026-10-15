"use client";

/**
 * CENAS / AUTOMAÇÕES / LUZ / GEOFFENCE — cliente do backend `ext_scenes`.
 *
 * O segredo (a sessão da conta) continua viajando no header `X-Nebula-Bundle`,
 * igual a `lib/api.ts`. Nada é guardado aqui.
 *
 * Os tipos ESPELHAM a resposta real, medida ao vivo contra o gateway móvel com
 * a conta de teste. O que a Tuya devolveu nessa conta, sem enfeite:
 *
 *   - `thing.m.linkage.rule.query` v1.0 devolveu **9 regras** (6 cenas + 3
 *     automações), coerente com `thing.m.linkage.rule.query.count`
 *     (`sceneCount: 6`, `automationCount: 3`, limite 200 dos dois).
 *     `ruleGenre` é o que separa: **1 = cena manual** (botão no app),
 *     **2 = automação** (tem gatilho).
 *   - `thing.m.linkage.rule.trigger` v1.0 — a API de execução — responde
 *     `{"result": true}` e, com um `ruleId` que não existe,
 *     `PERMISSION_DENIED / No access`. Ela existe e valida.
 *   - O caminho de leitura devolve as **condições** (gatilho) mas **descarta
 *     `actions`**: só vêm os passos `delay`. Os dispositivos que a cena
 *     aciona são um detalhe que o app guarda no banco local, alimentado pela
 *     família `m.scene.*` — que com esta sessão devolve
 *     `REMOTE_API_PARAM_ALL_INPUT_LOSS` em toda payload (ver o docstring de
 *     `backend/ext_scenes.py`). Por isso `Rule.devices` e `Rule.actions`
 *     chegam vazios: não há como preenchê-los sem inventar.
 *   - Timer vem em `conditions[].expr[]` com `time` + `loops` de 7 posições
 *     (domingo primeiro). `"0111110"` = segunda a sexta.
 *   - `smartlife.m.linkage.light.list` v1.0 e `m.light.rule.preset.creatable.check`
 *     v2.0 responderam, mas com lista vazia / `false`: esta conta não tem
 *     automação nem preset de luz.
 *   - `smartlife.m.linkage.fence.query` v2.0,
 *     `smartlife.m.device.geofence.list.by.uid` v1.0 e
 *     `m.message.device.alarm.nodisturb.list` v3.0 responderam `[]`: não há
 *     geofence nem "não perturbe" configurados.
 *   - `m.life.location.get` v3.4 devolve a casa com `lat`/`lon` (aqui 0/0, a
 *     conta não tem endereço salvo).
 */

import { API_BASE } from "../api";
import { bundleHeader } from "../bundle";

/** Caminho do módulo `ext_scenes` (SLUG = "scenes") no roteador do backend. */
export const SCENES_PATH = "/api/ext/scenes";

/** ruleGenre 1 = cena manual, 2 = automação com gatilho. */
export const GENRE_LABEL: Record<number, string> = {
  1: "cena",
  2: "automação",
};

/** O que a API devolve como `actionExecutor` num passo de ação. */
export const EXECUTOR_LABEL: Record<string, string> = {
  delay: "aguardar",
  toggle: "alternar",
  dpIssue: "comandar DP",
  irIssueVii: "enviar IR",
};

/** Só os tipos de condição que a conta de teste exercitou (entityType). */
export const CONDITION_LABEL: Record<string, string> = {
  timer: "relógio",
  geofence: "geofence",
  membro: "membro",
  modo_alarme: "modo de alarme",
  dispositivo: "dispositivo",
  manual: "toque na cena",
  desconhecido: "gatilho",
};

/* --------------------------------------------------------------------- gatilho */

export interface RuleWhen {
  /** "06:30" quando é timer; null nos outros gatilhos. */
  time: string | null;
  /** ["seg","ter",...] — domingo primeiro no gateway, já traduzido aqui. */
  days: string[];
  timezone: string | null;
  date: string | null;
}

export interface RuleCondition {
  kind: string;
  /** pronto para mostrar: "todo dia 06:30 (seg, ter, …)" */
  label: string;
  entity_id: string | null;
  entity_type: number | null;
  icon: string | null;
  order: number;
  when: RuleWhen;
}

/* ----------------------------------------------------------------------- ação */

export interface RuleAction {
  executor: string;
  label: string;
  entity_id: string | null;
  device_name: string | null;
  detail: string | null;
  enabled: boolean;
  order: number;
}

/* ------------------------------------------------------------------ a cena */

export interface RuleSchedule {
  time: string | null;
  days: string[];
  timezone: string | null;
  label: string;
}

export interface Rule {
  /** ruleId cru — é o que o botão Executar manda para o gateway. */
  id: string;
  name: string;
  kind: "scene" | "automation";
  genre: number | null;
  rule_type: number | null;
  /** ligado/desligado: exatamente o `enabled` da regra. */
  enabled: boolean;
  status: boolean;
  description: string | null;
  icon: string | null;
  color: string | null;
  /** devIds declarados — vazio quando o gateway não devolve (ver cabeçalho). */
  devices: string[];
  device_names: string[];
  rooms: string[];
  categories: string[];
  conditions: RuleCondition[];
  actions: RuleAction[];
  schedule: RuleSchedule | null;
  alarm: boolean;
  match: number | null;
  updated: number | null;
}

export interface RuleCounts {
  scenes: number;
  automations: number;
  scene_limit: number;
  automation_limit: number;
}

export interface ScenesReply {
  ok: boolean;
  gid?: string;
  rules: Rule[];
  counts: Partial<RuleCounts>;
  enabled: number;
  /** API que recusou, com o errorCode literal do servidor */
  warnings: string[];
  at: number;
  cached?: boolean;
}

/* ------------------------------------------------------------------------ luz */

export interface LightLinkage {
  id: string;
  name: string;
  enabled: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
}

export interface LightsReply {
  ok: boolean;
  gid?: string;
  linkage: LightLinkage[];
  /** `m.light.rule.preset.creatable.check` — false nesta conta. */
  preset_creatable: boolean;
  counts: { linkage: number };
  warnings: string[];
  at: number;
  cached?: boolean;
}

/* ------------------------------------------------------------------- geofence */

export interface Fence {
  id: string;
  name: string;
  enabled: boolean;
  lat: number | null;
  lon: number | null;
  radius: number | string | null;
  uid: string | null;
  /** os nomes de campo que o gateway devolveu, para não adivinhar o resto */
  raw_keys: string[];
}

export interface DeviceFence {
  device_id: string | null;
  device_name: string | null;
  id: string;
  name: string;
  enabled: boolean;
  lat: number | null;
  lon: number | null;
  radius: number | string | null;
}

export interface Nodisturb {
  id: string;
  dev_id: string | null;
  device_name: string | null;
  start: string | number | null;
  end: string | number | null;
  enabled: boolean;
  repeat: string | number | null;
}

export interface HomePlace {
  name: string;
  lat: number | null;
  lon: number | null;
  geo_name: string | null;
}

export interface GeofenceReply {
  ok: boolean;
  gid: string | null;
  uid: string | null;
  home: HomePlace;
  fences: Fence[];
  device_fences: DeviceFence[];
  nodisturb: Nodisturb[];
  counts: { fences: number; device_fences: number; nodisturb: number };
  warnings: string[];
  at: number;
  cached?: boolean;
}

/* ------------------------------------------------------------------- execução */

export interface RunReply {
  ok: boolean;
  /** o gateway devolveu `result: true` — a cena foi disparada. */
  triggered: boolean;
  rule_id: string;
  gid: string;
  result: unknown;
  at: number;
  warnings?: string[];
}

/* --------------------------------------------------------------- transporte */

async function get<T>(action: string, fresh = false): Promise<T> {
  const q = new URLSearchParams({ action });
  if (fresh) q.set("fresh", "1");
  const r = await fetch(`${API_BASE}${SCENES_PATH}/${action}?${q}`, {
    headers: bundleHeader(),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j as T;
}

async function post<T>(action: string, body: Record<string, string>): Promise<T> {
  const r = await fetch(`${API_BASE}${SCENES_PATH}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bundleHeader() },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
  return j as T;
}

export const extScenes = {
  list: (fresh = false) => get<ScenesReply>("list", fresh),
  lights: (fresh = false) => get<LightsReply>("lights", fresh),
  geofence: (fresh = false) => get<GeofenceReply>("geofence", fresh),
  detail: (ruleId: string) => post<ScenesReply & { rule: Rule | null }>("detail", { rule_id: ruleId }),
  /** dispara a cena — o mesmo botão que o app mostra na home. */
  run: (ruleId: string) => post<RunReply>("run", { rule_id: ruleId }),
};

/** "todos os dias" quando repete em 6+ dias, senão lista os nomes. */
export function scheduleLabel(days: string[]): string {
  if (!days.length) return "";
  if (days.length >= 6) return "todos os dias";
  return days.join(", ");
}