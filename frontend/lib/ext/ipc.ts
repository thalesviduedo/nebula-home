"use client";

/**
 * IPC / CAMERA + MENSAGENS / NOTIFICACOES — cliente do backend `ext_ipc`.
 *
 * Mesmo transporte do resto do app (`lib/api.ts`): base 127.0.0.1:8765 e o
 * segredo viaja no header `X-Nebula-Bundle` a cada requisicao. O backend e
 * sem estado.
 *
 * Os tipos ESPELHAM a resposta real, medida ao vivo contra o gateway movel
 * com a conta de teste:
 *   - `m.ipc.v4.rtc.config.get` v1.0 devolveu p2pType 4, 2 streams de video
 *     (1920x1080 + 640x360, H.264), 1 audio (G.711 mu-law 8kHz), claridades
 *     [2, 4], WebRTC sim, preconnect sim, transmissao "kcp".
 *   - `m.ipc.smart.image.quality.support.query` v1.0 -> `false` (a camera nao
 *     tem); `m.ipc.twoway.call.ability.get` -> `{enable: false}` (interfone
 *     desligado); `smartlife.m.ipc.ap.status` -> `{businessResult: false}`;
 *     `smartlife.m.ipc.ui.config.get` -> painel "1", tema "1".
 *   - `smartlife.m.msg.new` v1.0 {} -> `{alarm:false, family:true,
 *     notification:true}` (2 categorias nao lidas nesta conta).
 *   - `smartlife.m.msg.notice.switch.status` v1.0 quer `{"type": int 1..6}`
 *     e devolveu true,true,true,true,true,false.
 *   - `smartlife.m.notice.new.get` v1.0 {} -> `true` (ha aviso novo).
 *   - `m.message.device.alarm.nodisturb.list` SO na v3.0 -> `[]` (ninguem em
 *     nao-perturbe nesta conta).
 *
 * Nada aqui e credencial. O RTC devolve a sessao P2P inteira (auth, aesKey,
 * icePassword, credential do TURN...) e o backend descarta tudo antes de
 * responder — aqui chega so capacidade + host:port de infra.
 */

import { API_BASE } from "../api";
import { bundleHeader } from "../bundle";

/** Caminho do modulo `ext_ipc` (SLUG = "ipc") no roteador do backend. */
export const EXT_IPC_BASE = `${API_BASE}/api/ext/ipc`;

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${EXT_IPC_BASE}${path}`, { headers: bundleHeader() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error ?? `HTTP ${r.status}`);
  return j as T;
}

/* ------------------------------------------------------------------ *
 * caps — o que a camera REALMENTE suporta
 * ------------------------------------------------------------------ */

/** `stream_type` do SDK IPC: 2 = HD (principal), 4 = SD (secundaria). */
export interface IpcVideoStream {
  stream_type: number;
  codec_type: number;
  codec: string;
  width: number;
  height: number;
  sample_rate: number;
  size: string;
}

export interface IpcAudioCodec {
  codec_type: number;
  codec: string;
  sample_rate: number;
  channels: number;
}

export interface IpcP2p {
  id: string;
  p2p_type: number;
  p2p_specified_type: number;
  p2p_policy: number;
  is_cloud_p2p: boolean;
  is_low_power: boolean;
  is_4g_device: boolean;
  supports_webrtc: boolean;
  supports_webrtc_record: boolean;
  upgrade_relay: boolean;
  preconnect: boolean;
  max_zoom_in_times: number;
  video_clarity: number;
  /** claridades aceitas pelo firmware (2 = SD, 4 = HD na enumeracao Tuya) */
  video_clarities: number[];
  transmission: string;
  skill: {
    sdk_version: string;
    webrtc: number;
    p2p: number;
    cloud_gw: number;
    cloud_storage: number;
    video_num: number;
  };
  videos: IpcVideoStream[];
  audios: IpcAudioCodec[];
  audio_attributes: { call_modes: number[]; hardware_capability: number[] };
  ice_hosts: string[];
  relay_urls: string[];
  /** campos que o backend arrancou antes de responder */
  redacted: string[];
}

export interface IpcCaps {
  device: { id: string; name: string };
  p2p: IpcP2p;
  /** false = a camera nao tem smart image quality (resposta real) */
  smart_image_quality: boolean | null;
  /** {enable:false} = interfone desligado no aparelho (resposta real) */
  two_way: { enable: boolean } | null;
  /** {businessResult:false} = resposta real do servico AP */
  ap: { business_result: boolean | null } | null;
  ui: { setting_panel_version: string; setting_theme: string } | null;
  sources: Record<string, "ok" | "erro">;
  errors: Record<string, string>;
  cached: boolean;
}

/* ------------------------------------------------------------------ *
 * messages / notices
 * ------------------------------------------------------------------ */

export interface MessagesUnread {
  alarm: boolean;
  family: boolean;
  notification: boolean;
}

export interface MessagesState {
  unread: MessagesUnread;
  unread_count: number;
  switches: { type: number; on: boolean }[];
  switches_on: number;
  sources: Record<string, "ok" | "erro">;
  errors: Record<string, string>;
  cached: boolean;
}

export interface NodisturbDevice {
  id: string;
  name: string;
  enabled: boolean;
  switch: unknown;
  effect: unknown;
  time_range: unknown;
}

export interface NoticesState {
  new_notice: boolean | null;
  nodisturb: NodisturbDevice[];
  nodisturb_count: number;
  sources: Record<string, "ok" | "erro">;
  errors: Record<string, string>;
  cached: boolean;
}

/* ------------------------------------------------------------------ *
 * funcoes
 * ------------------------------------------------------------------ */

export function ipcCaps(id?: string): Promise<IpcCaps> {
  const q = id ? `&id=${encodeURIComponent(id)}` : "";
  return get<IpcCaps>(`?action=caps${q}`);
}

export function ipcMessages(): Promise<MessagesState> {
  return get<MessagesState>(`?action=messages`);
}

export function ipcNotices(): Promise<NoticesState> {
  return get<NoticesState>(`?action=notices`);
}

/** rotulos das 6 categorias que `smartlife.m.msg.notice.switch.status` aceita. */
export const SWITCH_LABELS: Record<number, string> = {
  1: "Alarme",
  2: "Família",
  3: "Notificação",
  4: "Evento",
  5: "Serviço",
  6: "Marketing",
};

/** claridade 2/4 na enumeracao do SDK IPC da Tuya. */
export const CLARITY_NAMES: Record<number, string> = {
  2: "SD",
  4: "HD",
};

export const STREAM_NAMES: Record<number, string> = {
  2: "principal",
  4: "secundária",
};
