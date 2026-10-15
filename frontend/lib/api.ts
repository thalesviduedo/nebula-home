import { bundleHeader } from "./bundle";

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8765";

export type Kind = "bulb" | "plug" | "ir" | "cam" | "cloud";

export interface Energy {
  tensao_v?: number;
  corrente_ma?: number;
  potencia_w?: number;
}

export interface Device {
  id: string;
  name: string;
  kind: Kind;
  ip: string | null;
  ok: boolean;
  on: boolean;
  local: boolean;
  /** dá para comandar sem estar na LAN: o gateway móvel relay o DPS */
  remote?: boolean;
  dps: Record<string, unknown>;
  energy: Energy;
  category?: string | null;
  productId?: string | null;
  /** id = MAC de 16 hex => Matter/ponte, não é um device Tuya direto */
  virtual?: boolean;
  note?: string;
  error?: string;
}

/** De onde a lista veio: nuvem (conta logada), cofre de chaves do navegador,
 *  ou vazio. O backend é sem estado — o scan só empresta IP/versão. */
export interface DeviceSource {
  source: "cloud" | "cache" | "chaves" | "vazio";
  cloud_error: string;
  lan_devices: number;
  vault: number;
  at: number;
}

export interface DeviceList {
  devices: Device[];
  source: DeviceSource;
}

export interface TvButton {
  key: string;
  label: string;
}

export interface RtspSource {
  path: string;
  name: string | null;
  deviceId: string | null;
  skill?: string | null;
  url: string;
  /** estado real de mídia vindo do endpoint /media do Go */
  media_state?: string;
  packets?: number;
  bytes?: number;
  keyframes?: number;
  packet_age?: number;
  clients?: number;
  last_error?: string;
  error_kind?: string;
}

export interface CloudSession {
  email: string | null;
  region: string | null;
  host: string | null;
  uid: string | null;
  cookies: number;
  file: string;
  lastRefresh: string | null;
  /** false = login por QR (só cookies): sem controle remoto, IR nuvem ou MQTT */
  full?: boolean;
}

export interface CloudStatus {
  logged_in: boolean;
  sessions: CloudSession[];
  region: string;
  rtsp: { base: string; alive: boolean; sources: RtspSource[] };
  qr: {
    running: boolean;
    png: string | null;
    png_mtime: number | null;
    started_at: number;
    log: string;
  };
  pyav: boolean;
  ipc_terminal: boolean;
  loginscript: boolean;
}

export interface CamStreamStatus {
  state: string;
  frames: number;
  fps: number;
  codec: string;
  size: string;
  error: string;
  history: string[];
  /** diagnóstico do stream seco (backend/tuya_rtsp.py) */
  attempts?: number;
  bytes?: number;
  dry_for?: number;
  error_kind?: string;
  connected_for?: number;
  first_frame_in?: number | null;
}

/** O que o backend fez para consertar (ou não conseguiu). */
export interface CamWatchdog {
  health_reachable: boolean;
  health: {
    connect_timeout_sec?: number;
    stall_timeout_sec?: number;
    dry_deadline_sec?: number;
    cameras_streaming?: number;
    cameras_total?: number;
  };
  cameras: CamCameraHealth[];
  restart_count: number;
  process_restarts?: number;
  restart_log: string[];
  last_action: string;
  last_action_at: number | null;
  pid: number | null;
}

export interface CamCameraHealth {
  path: string;
  name: string;
  deviceId: string;
  state: "idle" | "connecting" | "live" | "stalled" | "failed";
  connected: boolean;
  clients: number;
  media: {
    videoPackets: number;
    videoBytes: number;
    keyframes: number;
    lastPacketAgeSec: number;
  };
  connectingForSec: number;
  lastError?: string;
  errorKind?: string;
  teardowns?: number;
}

export interface CamReader {
  url: string;
  state: string;
  frames: number;
  attempts: number;
  dry_for: number;
  error: string;
  error_kind: string;
  codec: string;
  fps: number;
}

/**
 * Tradução de sintoma em ação. `action: "relogin"` é o caso que importava:
 * a sessão expirou e nenhum restart de ponte resolve — só refazer login.
 */
export interface CamDiagnosis {
  cause: string;
  fix: string;
  action: "relogin" | "retry" | "wait" | "none";
  retryable: boolean;
}

export interface CamSources {
  base: string;
  alive: boolean;
  /** a ponte de vídeo sobe sozinha quando chega sessão no bundle */
  auto: boolean;
  error: string;
  error_kind: string;
  /** "relogin" quando só refazer o login resolve */
  action: string;
  log: string;
  restart_count: number;
  last_action: string;
  sources: RtspSource[];
  pyav: boolean;
}

export interface CamStatus {
  rtsp_base: string;
  rtsp_path: string;
  target: string | null;
  mode: "rtsp" | "emulator";
  has_av: boolean | null;
  alive: boolean;
  auto: boolean;
  error: string;
  error_kind: string;
  action: string;
  log: string;
  watchdog: CamWatchdog;
  diagnosis: CamDiagnosis;
  readers: CamReader[];
  sources: RtspSource[];
  streams: CamStreamStatus[];
  probe?: { ok: boolean; codec?: string; size?: string; error?: string; url: string };
}

async function get<T>(path: string): Promise<T> {
  // O segredo viaja em toda chamada: o backend é sem estado.
  const r = await fetch(`${API_BASE}${path}`, { headers: bundleHeader() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bundleHeader() },
    body: JSON.stringify(body ?? {}),
  });
  const j = await r.json();
  if (!r.ok && j?.error) throw new Error(j.error);
  return j as T;
}

export const api = {
  devices: (fast = false) => get<DeviceList>(`/api/devices${fast ? "?fast=1" : ""}`),
  status: (id: string) => get<Device>(`/api/status?id=${id}`),
  control: (id: string, action: string, params: Record<string, string | number> = {}) => {
    const q = new URLSearchParams({
      id,
      action,
      ...Object.fromEntries(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ),
    });
    return get<{
      ok: boolean;
      dps?: Record<string, unknown>;
      energy?: Energy;
      error?: string;
      on?: boolean;
    }>(`/api/control?${q}`);
  },

  irButtons: () => get<{ count: number; buttons: TvButton[] }>(`/api/ir/buttons`),
  /**
   * Baixa os botões do controle virtual IR direto da nuvem da Tuya
   * (`tuya.m.infrared.keydata.get`), sem precisar do arquivo de backup.
   * O bloco `ir` volta pronto para `setIr()`; `learned` traz o que foi
   * aprendido no blaster (`tuya.m.infrared.learn.get`), em hex e base64.
   */
  irCloudKeys: (opts: { id?: string; learned?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.id) q.set("id", opts.id);
    if (opts.learned) q.set("learned", "1");
    return get<{
      ok: boolean;
      error?: string;
      devId?: string;
      gwId?: string;
      brandName?: string | null;
      devTypeName?: string | null;
      count?: number;
      head?: string;
      ir?: { head: string; keys: Record<string, { pulse: string }> };
      learned?: {
        keyId: string | number;
        name: string | null;
        hex: string;
        base64: string;
        freq: number | null;
      }[];
      learned_count?: number;
      buttons?: TvButton[];
    }>(`/api/ir/cloud-keys?${q}`);
  },
  ir: (button: string) =>
    get<{ ok: boolean; button?: string; error?: string }>(
      `/api/control?${new URLSearchParams({ id: "tv-remote", action: "ir", button })}`,
    ),

  // --- câmera ---------------------------------------------------------
  /**
   * Só existe o caminho RTSP: a câmera não abre porta na LAN, então o
   * vídeo vem do relay de nuvem. Sem `path` o backend responde com um
   * frame de erro explicando o que falta.
   */
  camStreamUrl: (opts: { path?: string; width?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.path) q.set("url", opts.path);
    if (opts.width) q.set("w", String(opts.width));
    q.set("t", String(Date.now()));
    return `${API_BASE}/api/cam.mjpeg?${q}`;
  },
  camStatus: (path = "", probe = false) =>
    get<CamStatus>(`/api/cam.status?probe=${probe ? 1 : 0}${path ? `&url=${encodeURIComponent(path)}` : ""}`),
  camSources: () =>
    get<CamSources>(`/api/cam/sources`),

  // --- nuvem ----------------------------------------------------------
  config: () => get<AppConfig>(`/api/config`),
  cloudStatus: () => get<CloudStatus>(`/api/cloud/status`),
  startQr: () => get<CloudStatus & { ok?: boolean; error?: string }>(`/api/cloud/qr?go=1`),
  qrPngUrl: () => `${API_BASE}/api/cloud/qr.png?t=${Date.now()}`,

  login: (body: { email: string; password: string; country?: string; region?: string }) =>
    post<{ ok: boolean; uid?: string; email?: string; cloud: CloudBlock; error?: string;
           keys?: Record<string, DeviceKey>; warning?: string }>(
      "/api/cloud/login", body,
    ),
  logout: () => post<{ ok: boolean }>("/api/cloud/logout"),

  // --- bundle (o backend não guarda nada) ---
  qrStart: () => post<{ token: string; payload: string; image: string | null; region: string; host: string }>("/api/cloud/qr/start"),
  qrPoll: (token: string) =>
    post<{ ok: boolean; state: string; msg?: string; cloud?: CloudBlock;
           keys?: Record<string, DeviceKey>; warning?: string }>("/api/cloud/qr/poll", { token }),
  previewBundle: () => post<BundlePreview>("/api/bundle/preview"),
  applyKeys: (keys: Record<string, DeviceKey>) =>
    post<{ ok: boolean; usable: string[]; total: number }>("/api/registry/apply", { keys }),
};export interface CloudBlock {
  host: string;
  region: string;
  uid: string;
  email: string;
  cookies: { name: string; value: string }[];
}

export interface DeviceKey {
  localKey: string;
  name?: string;
  kind?: string;
  role?: string;
  ip?: string;
  ver?: string;
}

export interface BundlePreview {
  version: number;
  keys: number;
  cloud: boolean;
  cloud_email: string | null;
  cloud_region: string | null;
  ir_codes: number;
}

export interface P2pCodec {
  stream_type: number;
  codec_type: number;
  size: string;
}

export interface P2pFacts {
  device_id: string;
  is_cloud_p2p: boolean;
  p2p_type: number;
  transmission: string;
  tcp_relay: string[];
  ice_servers: string[];
  sdk_version?: string;
  supports_webrtc: boolean;
  preconnect?: boolean;
  codecs: P2pCodec[];
  audio?: Record<string, number>[];
  source: string;
}

export interface AppConfig {
  region: string;
  country: string;
  dashboard_url: string;
  rtsp_base: string;
  api: Record<string, string>;
  ir_blaster: { id: string; name: string; ip: string | null; version: string } | null;
  camera: { id: string; name: string; ip: string | null } | null;
  p2p: P2pFacts | Record<string, never>;
}

/** codec_type 2 = H.264 na enumeração do SDK IPC da Tuya */
export const CODEC_NAMES: Record<number, string> = {
  0: "unknown",
  1: "H.264",
  2: "H.264",
  3: "H.265",
  101: "G.711 µ-law",
  102: "G.711 A-law",
};

export const codecName = (n: number) => CODEC_NAMES[n] ?? `codec ${n}`;
