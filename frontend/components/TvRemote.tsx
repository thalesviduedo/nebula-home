"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle,
  FastForward, History, Info, List, Menu, Pause, Play, Power, Radio, Rewind,
  Settings, Square, Tv, Volume1, Volume2, VolumeX, Zap,
} from "lucide-react";
import { api, type TvButton } from "@/lib/api";
import { useNotify } from "@/lib/query";
import { useConfig } from "@/hooks/useConfig";

/** Layout do controle Philips: D-pad no centro, transporte embaixo, teclas de
 *  cor ao lado. Só entram botões que existem nos códigos aprendidos. */
const DIAL: { key: string; icon: typeof ChevronUp; label: string; primary?: boolean; pos: string }[] = [
  { key: "navigate_up", icon: ChevronUp, label: "Cima", pos: "top-2 left-1/2 -translate-x-1/2" },
  { key: "navigate_left", icon: ChevronLeft, label: "Esquerda", pos: "left-2 top-1/2 -translate-y-1/2" },
  { key: "navigate_right", icon: ChevronRight, label: "Direita", pos: "right-2 top-1/2 -translate-y-1/2" },
  { key: "navigate_down", icon: ChevronDown, label: "Baixo", pos: "bottom-2 left-1/2 -translate-x-1/2" },
];

const VOLUME: { key: string; icon: typeof Volume2; label: string }[] = [
  { key: "volume_up", icon: Volume2, label: "Vol +" },
  { key: "volume_down", icon: Volume1, label: "Vol −" },
];

const CHANNEL: { key: string; label: string }[] = [
  { key: "channel_up", label: "CH +" },
  { key: "channel_down", label: "CH −" },
];

const TRANSPORT: { key: string; icon: typeof Play; label: string; danger?: boolean }[] = [
  { key: "rewind", icon: Rewind, label: "Recuar" },
  { key: "play", icon: Play, label: "Play" },
  { key: "fast_forward", icon: FastForward, label: "Avançar" },
  { key: "pause", icon: Pause, label: "Pausar" },
  { key: "stop", icon: Square, label: "Parar" },
  { key: "record", icon: Circle, label: "Gravar", danger: true },
];

const NAV: { key: string; icon?: typeof Menu; label: string }[] = [
  { key: "homepage", icon: Tv, label: "Início" },
  { key: "back", icon: ArrowLeft, label: "Voltar" },
  { key: "menu", icon: Menu, label: "Menu" },
  { key: "options", icon: Settings, label: "Opções" },
  { key: "source", icon: Radio, label: "Entrada" },
  { key: "guide", label: "Guia" },
  { key: "info", icon: Info, label: "Info" },
  { key: "list", icon: List, label: "Lista" },
];

const COLOR_KEYS = [
  { key: "red", cls: "bg-error" },
  { key: "green", cls: "bg-mint" },
  { key: "yellow", cls: "bg-tertiary" },
  { key: "blue", cls: "bg-primary" },
];

const LABEL: Record<string, string> = {
  power: "Power", ok: "OK", channel_up: "CH+", channel_down: "CH−",
  menu: "Menu", navigate_up: "Cima", navigate_down: "Baixo",
  navigate_left: "Esquerda", navigate_right: "Direita",
  volume_up: "Vol+", volume_down: "Vol−", mute: "Mudo",
  input: "Entrada", back: "Voltar", exit: "Sair", last: "Anterior",
  homepage: "Início", rewind: "Recuar", play: "Play",
  fast_forward: "Avançar", record: "Gravar", stop: "Parar", pause: "Pausar",
  mouse: "Mouse", info: "Info", red: "Vermelho", green: "Verde",
  blue: "Azul", yellow: "Amarelo", "3d": "3D", guide: "Guia",
  set: "Definir", tv: "TV", help: "Ajuda", teletext: "Teletext",
  options: "Opções", list: "Lista", ambilight: "Ambilight",
  aspect: "Formato", adjustment: "Ajuste", "smart tv": "Smart TV",
  liushengyicai: "Liu Sheng Yi Cai", "streamer symphony": "Sinfonia",
  "feature list": "Recursos", return: "Retornar", source: "Entrada",
  smarttv: "Smart TV", subtitle: "Legenda", format: "Formato",
};

interface SendRecord {
  key: string;
  label: string;
  ms: number;
  at: string;
  ok: boolean;
}

const time = () => new Date().toLocaleTimeString("pt-BR", { hour12: false });

export default function TvRemote() {
  const notify = useNotify();
  const [last, setLast] = useState<string>("pronto");
  const [sends, setSends] = useState<SendRecord[]>([]);

  const { data: cfg } = useConfig();
  const { data, isPending, isError } = useQuery({
    queryKey: ["ir-buttons"],
    queryFn: () => api.irButtons(),
    staleTime: 60_000,
  });
  const send = useMutation({ mutationFn: (key: string) => api.ir(key) });

  const buttons = data?.buttons ?? [];
  const have = new Set(buttons.map((b: TvButton) => b.key));
  const show = (k: string) => (have.size === 0 ? true : have.has(k));

  // teclas que existem no cofre mas não têm lugar no layout do controle
  const placed = new Set([
    ...DIAL.map((d) => d.key), ...VOLUME.map((v) => v.key),
    ...CHANNEL.map((c) => c.key), ...TRANSPORT.map((t) => t.key),
    ...NAV.map((n) => n.key), ...COLOR_KEYS.map((c) => c.key),
    "ok", "mute", "power", ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ]);
  const extra = buttons.filter((b) => !placed.has(b.key));

  async function press(key: string, label: string) {
    if (send.isPending) return;
    const t0 = performance.now();
    try {
      const r = await send.mutateAsync(key);
      const ms = Math.round(performance.now() - t0);
      setLast(r.ok ? `${label} enviado` : (r.error ?? "falhou"));
      setSends((list) => [{ key, label, ms, at: time(), ok: r.ok }, ...list].slice(0, 12));
      notify(r.ok ? `${label} enviado ao blaster` : `falha: ${r.error}`, r.ok ? "ok" : "err");
    } catch (e) {
      setLast(`erro: ${e}`);
      notify(`falha de rede: ${e}`, "err");
    }
  }

  const BTN_BASE =
    "flex items-center justify-center rounded-xl bg-surface-container-high text-on-surface transition-all hover:bg-surface-bright active:scale-95 disabled:opacity-60";

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-6 px-5 py-6">
      {/* ---- cabeçalho de contexto ---- */}
      <div className="flex flex-col justify-between gap-4 rounded-xl bg-surface-container-low p-5 shadow-xl backdrop-blur-md lg:flex-row lg:items-center">
        <div className="flex items-center gap-2.5">
          <div className="grid size-10 place-items-center rounded-xl bg-primary-container/20 text-primary shadow-[0_0_20px_rgba(76,215,246,0.25)]">
            <Radio className="size-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-on-surface">
                Controle Infravermelho
              </h1>
              {cfg?.ir_blaster?.version && (
                <span className="rounded-full bg-secondary-container/20 px-2 py-0.5 font-mono text-[11px] text-mint">
                  Blaster v{cfg.ir_blaster.version}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2.5 text-[11px] text-on-surface-variant">
              <span>
                {cfg?.ir_blaster
                  ? `${cfg.ir_blaster.name} · ${cfg.ir_blaster.ip ?? "sem IP"}`
                  : "Blaster IR — via nuvem Tuya"}
              </span>
              <span className="inline-block size-1 rounded-full bg-outline" />
              <span className="font-mono text-primary">
                {isPending ? "carregando códigos…" : isError ? "sem resposta" : `${buttons.length} Códigos Sincronizados`}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-xl bg-surface-container-high p-1">
          <span className="flex items-center gap-2 rounded-lg bg-primary-container px-4 py-2 text-[12px] font-medium text-on-primary shadow-[0_0_12px_rgba(76,215,246,0.3)]">
            <Tv className="size-4" />
            {cfg?.ir_blaster?.name ?? "Aparelho IR"}
          </span>
        </div>
      </div>

      {(data?.count ?? -1) === 0 && !isPending && (
        <p className="rounded-xl border border-tertiary/30 bg-tertiary-container/10 px-3 py-2 text-xs text-tertiary">
          Sem códigos IR neste navegador — baixe as keys em{" "}
          <span className="text-on-surface">Inventário &amp; Chaves Tuya → Keys IR da nuvem</span>.
        </p>
      )}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* ---- chassis do controle (7 cols) ---- */}
        <div className="flex flex-col gap-5 rounded-xl bg-surface-container-low p-6 shadow-2xl backdrop-blur-2xl lg:col-span-7">
          {/* power / mute */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <span className="size-2.5 rounded-full bg-mint" />
              <span className="text-[15px] text-on-surface">{last}</span>
            </div>
            <div className="flex items-center gap-2">
              {show("mute") && (
                <button type="button" className={`${BTN_BASE} size-10`} onClick={() => press("mute", "Mudo")} title="Mudo">
                  <VolumeX className="size-5" />
                </button>
              )}
              {show("source") ? null : show("input") && (
                <button type="button" className={`${BTN_BASE} h-10 px-3 text-[12px] font-medium`} onClick={() => press("input", "Entrada")} title="Entrada / Source">
                  HDMI 1
                </button>
              )}
              {show("power") && (
                <button
                  type="button"
                  disabled={send.isPending}
                  onClick={() => press("power", "Power")}
                  className="flex items-center gap-2 rounded-xl bg-error px-4 py-2 text-[13px] font-semibold text-on-error shadow-[0_0_20px_rgba(255,180,171,0.3)] transition-all hover:brightness-110 active:scale-95 disabled:opacity-60"
                >
                  <Power className="size-5" />
                  Power
                </button>
              )}
            </div>
          </div>

          {/* D-pad circular + rockers */}
          <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-12">
            <div className="flex flex-col items-center justify-center py-2 md:col-span-7">
              <div className="relative flex size-64 items-center justify-center rounded-full bg-surface-container-lowest/80 p-2 shadow-[inset_0_2px_10px_rgba(0,0,0,0.6)]">
                {DIAL.map((d) => {
                  if (!show(d.key)) return null;
                  const busy = send.isPending && send.variables === d.key;
                  return (
                    <button
                      key={d.key}
                      type="button"
                      aria-label={d.label}
                      disabled={send.isPending}
                      onClick={() => press(d.key, d.label)}
                      className={`absolute ${d.pos} grid size-14 place-items-center rounded-full bg-surface-container-high text-on-surface transition-all hover:bg-surface-bright active:bg-primary-container active:text-on-primary disabled:opacity-60`}
                    >
                      {busy ? (
                        <Circle className="size-6 animate-pulse" />
                      ) : (
                        <d.icon className="size-7" />
                      )}
                    </button>
                  );
                })}
                {show("ok") && (
                  <button
                    type="button"
                    disabled={send.isPending}
                    onClick={() => press("ok", "OK")}
                    className="relative z-10 grid size-24 place-items-center rounded-full bg-gradient-to-tr from-surface-container to-surface-container-highest text-primary shadow-[0_0_25px_rgba(76,215,246,0.35)] transition-all hover:from-surface-container-high hover:to-surface-bright active:scale-95 disabled:opacity-60"
                  >
                    <span className="flex flex-col items-center gap-0.5">
                      <Zap className="size-7" />
                      <span className="font-mono text-[11px] font-bold text-on-surface">OK</span>
                    </span>
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-row justify-around gap-4 md:col-span-5 md:flex-col">
              <div className="flex flex-1 flex-col items-center rounded-xl bg-surface-container p-2 shadow-md">
                <span className="mb-1 text-[10px] uppercase tracking-wider text-outline">
                  Volume
                </span>
                <div className="flex w-full flex-col gap-1">
                  {VOLUME.filter((v) => show(v.key)).map((v) => (
                    <button
                      key={v.key}
                      type="button"
                      disabled={send.isPending}
                      onClick={() => press(v.key, v.label)}
                      className="flex-1 rounded-lg bg-surface-container-high py-3.5 text-on-surface transition-all hover:bg-surface-bright active:bg-primary active:text-on-primary disabled:opacity-60"
                    >
                      <v.icon className="mx-auto size-5" />
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-1 flex-col items-center rounded-xl bg-surface-container p-2 shadow-md">
                <span className="mb-1 text-[10px] uppercase tracking-wider text-outline">
                  Canal
                </span>
                <div className="flex w-full flex-col gap-1">
                  {CHANNEL.filter((c) => show(c.key)).map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      disabled={send.isPending}
                      onClick={() => press(c.key, c.label)}
                      className="flex-1 rounded-lg bg-surface-container-high py-3.5 font-mono text-[13px] text-on-surface transition-all hover:bg-surface-bright active:bg-primary active:text-on-primary disabled:opacity-60"
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* navegação secundária */}
          <div className="flex flex-wrap items-center justify-between gap-1.5 pt-1">
            {NAV.filter((n) => show(n.key)).map((n) => (
              <button
                key={n.key}
                type="button"
                disabled={send.isPending}
                onClick={() => press(n.key, n.label)}
                className="flex min-w-[70px] flex-1 flex-col items-center gap-1 rounded-lg bg-surface-container py-2 text-on-surface transition-all hover:bg-surface-container-high active:scale-95 disabled:opacity-60"
              >
                {n.icon ? <n.icon className="size-5" /> : <span className="size-5" />}
                <span className="text-[11px]">{n.label}</span>
              </button>
            ))}
          </div>

          {/* teclas de cor */}
          <div className="flex items-center justify-center gap-4 py-1">
            {COLOR_KEYS.filter((c) => show(c.key)).map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={LABEL[c.key]}
                disabled={send.isPending}
                onClick={() => press(c.key, LABEL[c.key])}
                className={`h-3.5 max-w-[90px] flex-1 rounded-full ${c.cls} shadow-[0_0_10px_rgba(255,255,255,0.15)] transition-all hover:brightness-125 active:scale-95 disabled:opacity-60`}
              />
            ))}
          </div>

          {/* transporte */}
          <div className="flex items-center justify-between gap-2 rounded-xl bg-surface-container-lowest/60 p-2">
            {TRANSPORT.filter((t) => show(t.key)).map((t) => (
              <button
                key={t.key}
                type="button"
                aria-label={t.label}
                disabled={send.isPending}
                onClick={() => press(t.key, t.label)}
                className={`grid size-10 place-items-center rounded-lg transition-all hover:bg-surface-container-high active:scale-95 disabled:opacity-60 ${
                  t.danger ? "text-error" : t.key === "play" ? "text-primary" : "text-on-surface"
                }`}
              >
                <t.icon className="size-5" />
              </button>
            ))}
          </div>

          {/* teclado numérico */}
          <div className="flex flex-col gap-2 pt-1">
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-wider text-outline">
                Teclado Numérico Direto
              </span>
              <span className="font-mono text-[11px] text-primary">DP_RAW: TX READY</span>
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]
                .filter((n) => show(n))
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    disabled={send.isPending}
                    onClick={() => press(n, n)}
                    className="rounded-lg bg-surface-container py-2.5 text-center font-mono text-[18px] font-semibold text-on-surface transition-all hover:bg-surface-container-high active:bg-primary-container active:text-on-primary disabled:opacity-60"
                  >
                    {n}
                  </button>
                ))}
            </div>
          </div>
        </div>

        {/* ---- coluna de engenharia (5 cols) ---- */}
        <div className="flex flex-col gap-6 lg:col-span-5">
          {/* hardware real do blaster (fatos do /api/config) */}
          <div className="flex flex-col gap-4 rounded-xl bg-surface-container-low p-5 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="size-5 text-primary" />
                <span className="text-[15px] text-on-surface">Hardware IR Blaster</span>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-mint/10 px-2 py-0.5">
                <span className={`size-2 rounded-full ${isError ? "bg-error" : "bg-mint"}`} />
                <span className="text-[11px] text-mint">
                  {isError ? "sem resposta" : `${buttons.length} códigos no cofre`}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 rounded-xl bg-surface-container-lowest p-3">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase text-outline">Aparelho</span>
                <span className="truncate font-mono text-[13px] text-primary">
                  {cfg?.ir_blaster?.id?.slice(0, 8) ?? "—"}…
                </span>
                <span className="text-[10px] text-on-surface-variant">devId Tuya</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase text-outline">IP</span>
                <span className="font-mono text-[13px] text-mint">
                  {cfg?.ir_blaster?.ip ?? "nuvem"}
                </span>
                <span className="text-[10px] text-on-surface-variant">
                  {cfg?.ir_blaster?.ip ? "LAN" : "fora da LAN"}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase text-outline">Protocolo</span>
                <span className="font-mono text-[13px] text-tertiary">
                  v{cfg?.ir_blaster?.version ?? "?"}
                </span>
                <span className="text-[10px] text-on-surface-variant">Tuya IR</span>
              </div>
            </div>
          </div>

          {/* histórico de disparos — medido no cliente, real */}
          <div className="flex flex-col gap-4 rounded-xl bg-surface-container-low p-5 shadow-xl backdrop-blur-xl">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="size-5 text-mint" />
                <span className="text-[15px] text-on-surface">Histórico de Disparos</span>
              </div>
              <span className="font-mono text-[11px] text-mint">sessão local</span>
            </div>
            <div className="flex max-h-56 flex-col gap-1.5 overflow-y-auto pr-1">
              {sends.length === 0 && (
                <p className="rounded bg-surface-container p-3 text-[11px] text-on-surface-variant">
                  nenhum disparo nesta sessão — o que aparecer aqui foi medido de verdade
                </p>
              )}
              {sends.map((s, i) => (
                <div
                  key={`${s.at}-${s.key}-${i}`}
                  className="flex items-center justify-between rounded bg-surface-container p-2 text-[13px]"
                >
                  <div className="flex items-center gap-2">
                    <span className={`size-1.5 rounded-full ${s.ok ? "bg-mint" : "bg-error"}`} />
                    <span className="font-mono text-[11px] text-on-surface">{s.label}</span>
                    <span className="text-[11px] text-on-surface-variant">
                      {cfg?.ir_blaster?.name ?? "blaster"}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-[11px] text-outline">{s.ms}ms</span>
                    <span className="text-[11px] text-on-surface-variant">{s.at}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* teclas sem lugar no layout (ex. ambilight, teletext, formatos) */}
          {extra.length > 0 && (
            <div className="flex flex-col gap-3 rounded-xl bg-surface-container-low p-5 shadow-xl backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <List className="size-5 text-tertiary" />
                  <span className="text-[15px] text-on-surface">Outras teclas do cofre</span>
                </div>
                <span className="font-mono text-[11px] text-on-surface-variant">
                  {extra.length} disponíveis
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {extra.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    disabled={send.isPending}
                    onClick={() => press(b.key, b.label || LABEL[b.key] || b.key)}
                    className="rounded-lg bg-surface-container px-2.5 py-1.5 font-mono text-[11px] text-on-surface-variant transition-colors hover:bg-surface-bright hover:text-on-surface disabled:opacity-60"
                    title={b.key}
                  >
                    {b.label || LABEL[b.key] || b.key}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
