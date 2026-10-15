"use client";

/**
 * O dono do segredo é o navegador.
 *
 * O backend não guarda nada: chaves (localKey), sessão da conta e códigos IR
 * ficam aqui, em `localStorage`, e viajam em TODA requisição no header
 * `X-Nebula-Bundle` (base64 de um JSON). O servidor monta a resposta,
 * devolve e esquece.
 *
 * Consequência honesta: limpar os dados do navegador ou trocar de navegador
 * significa entrar de novo. Por isso existe exportar/importar.
 *
 * Isto é a única chave que este painel escreve. Todo o resto do storage é
 * bloqueado por `no-persistence.ts`.
 */

import type { P2pFacts } from "./api";

export const STORAGE_KEY = "nebula.bundle.v1";

export interface DeviceKey {
  localKey: string;
  name?: string;
  kind?: string;
  role?: string;
  ip?: string;
  ver?: string;
  productId?: string;
}

export interface CloudBlock {
  host: string;
  region: string;
  uid: string;
  email: string;
  accessToken?: string;
  sid?: string;
  mobileApiUrl?: string;
  cookies: { name: string; value: string }[];
}

export interface IrBlock {
  head: string;
  keys: Record<string, { pulse: string }>;
}

export interface Bundle {
  v: 1;
  keys: Record<string, DeviceKey>;
  cloud: CloudBlock | null;
  ir: IrBlock | null;
}

const EMPTY: Bundle = { v: 1, keys: {}, cloud: null, ir: null };

let cache: Bundle | null = null;
const listeners = new Set<(b: Bundle) => void>();

export function getBundle(): Bundle {
  if (cache) return cache;
  let loaded: Bundle = { ...EMPTY };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) loaded = { ...EMPTY, ...JSON.parse(raw) };
  } catch {
    loaded = { ...EMPTY };
  }
  // O cofre guarda segredo (localKey) ou papel (ex.: ir-blaster). Entrada
  // sem nenhum dos dois é resíduo de scan antigo — some na carga para o
  // painel não listar "fantasma" que ninguém controla.
  const keys: Record<string, DeviceKey> = {};
  for (const [id, k] of Object.entries(loaded.keys ?? {})) {
    if (k && (k.localKey || k.role)) keys[id] = k;
  }
  const dropped = Object.keys(loaded.keys ?? {}).length !== Object.keys(keys).length;
  loaded = { ...loaded, keys };
  cache = loaded;
  if (dropped) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
    } catch {
      /* storage indisponível: segue em memória */
    }
  }
  return loaded;
}

function commit(next: Bundle) {
  cache = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage indisponível: segue em memória */
  }
  listeners.forEach((fn) => fn(next));
}

export function subscribe(fn: (b: Bundle) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function setBundle(next: Bundle) {
  commit(next);
}

export function clearBundle() {
  commit({ ...EMPTY, keys: {}, cloud: null, ir: null });
}

// --- mutadores pontuais -----------------------------------------------------
export function mergeKeys(keys: Record<string, DeviceKey>) {
  const b = getBundle();
  const merged: Record<string, DeviceKey> = { ...b.keys };
  for (const [id, k] of Object.entries(keys)) {
    const prev = merged[id];
    // o login devolve só segredo/nome/ip: papel (ex. ir-blaster) e tipo
    // ajustado pelo dono moram só no navegador e não podem se perder aqui
    merged[id] = prev
      ? { ...k, role: k.role ?? prev.role, kind: k.kind ?? prev.kind }
      : k;
  }
  commit({ ...b, keys: merged });
}

export function setDeviceKind(id: string, kind: string) {
  const b = getBundle();
  const prev = b.keys[id];
  if (!prev) return;
  commit({ ...b, keys: { ...b.keys, [id]: { ...prev, kind } } });
}

export function setCloud(cloud: CloudBlock | null) {
  const b = getBundle();
  commit({ ...b, cloud });
}

export function setIr(ir: IrBlock | null) {
  const b = getBundle();
  commit({ ...b, ir });
}

/** IP visto no scan fica no navegador, não no servidor — mas só para quem
 *  já existe no cofre (tem chave ou papel). O scan não cria entrada nova:
 *  quem entra na lista é quem o navegador conhece, não o que a rede achou. */
export function rememberLan(lan: Record<string, { ip: string; ver?: string }>) {
  const b = getBundle();
  const keys = { ...b.keys };
  let changed = false;
  for (const [id, v] of Object.entries(lan)) {
    const prev = keys[id];
    if (!prev) continue;
    if (prev.ip === v.ip && prev.ver === v.ver) continue;
    keys[id] = { ...prev, ip: v.ip, ver: v.ver };
    changed = true;
  }
  if (changed) commit({ ...b, keys });
}

// --- transporte -------------------------------------------------------------
function encode(b: Bundle): string {
  const json = JSON.stringify({ v: 1, keys: b.keys, cloud: b.cloud, ir: b.ir });
  // base64url, sem depender de Buffer (roda no browser)
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  bytes.forEach((c) => (bin += String.fromCharCode(c)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Header para toda chamada. Vazio = ainda não há nada guardado. */
export function bundleHeader(): Record<string, string> {
  const b = getBundle();
  if (!b.keys && !b.cloud && !b.ir) return {};
  return { "X-Nebula-Bundle": encode(b) };
}

export type BundleSummary = {
  keys: number;
  cloud: string | null;
  region: string | null;
  ir: number;
};

export function bundleSummary(b: Bundle = getBundle()): BundleSummary {
  return {
    // entrada sem localKey é device que o scan achou, não uma chave
    keys: Object.values(b.keys).filter((k) => k.localKey).length,
    cloud: b.cloud?.email ?? null,
    region: b.cloud?.region ?? null,
    ir: Object.keys(b.ir?.keys ?? {}).length,
  };
}

/**
 * Snapshot do servidor para `useSyncExternalStore`: o segredo só existe no
 * navegador, então o SSR enxerga um bundle vazio e estável (referência única,
 * como o hook exige). Sem isso o primeiro render do cliente diverge do HTML
 * do servidor e o React acusa hydration mismatch.
 */
export function serverBundle(): Bundle {
  return EMPTY;
}

// --- backup -----------------------------------------------------------------
export function exportBundle(): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(getBundle(), null, 2))));
}

export function importBundle(text: string): Bundle {
  const raw = text.trim();
  let json: string;
  try {
    // formato do Exportar: base64
    json = decodeURIComponent(escape(atob(raw)));
    JSON.parse(json);
  } catch {
    // backup em JSON cru (ex. nebula-bundle.txt)
    json = raw;
  }
  const parsed = JSON.parse(json) as Partial<Bundle>;
  const b = getBundle();
  // importar incorpora, não destrói: vale para restaurar num navegador vazio
  // e para trazer os códigos IR sem derrubar a sessão/chaves atuais
  const keys: Record<string, DeviceKey> = { ...b.keys };
  for (const [id, k] of Object.entries(parsed.keys ?? {})) {
    const prev = keys[id];
    keys[id] = prev
      ? { ...k, ...prev, role: prev.role ?? k.role, kind: prev.kind ?? k.kind }
      : (k as DeviceKey);
  }
  const fileCloud = parsed.cloud ?? null;
  const next: Bundle = {
    v: 1,
    keys,
    cloud:
      b.cloud?.cookies?.length || !fileCloud?.cookies?.length ? b.cloud : fileCloud,
    ir: parsed.ir ?? b.ir,
  };
  commit(next);
  return next;
}

export type { P2pFacts };