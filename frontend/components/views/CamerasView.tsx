"use client";

import { useMemo } from "react";
import {
  Activity, CloudOff, Radio, RefreshCw, Satellite, Video,
} from "lucide-react";
import { useCamSources, useCamStreamStatus, useCloudStatus } from "@/hooks/useCloud";
import { useConfig } from "@/hooks/useConfig";
import { useDevices } from "@/hooks/useDevices";
import { useShell } from "@/lib/shell";
import CameraCard from "@/components/CameraCard";
import CloudRequired from "@/components/CloudRequired";

const BADGE = "rounded-full px-2.5 py-0.5 text-[11px] font-medium";

function mediaBadge(state: string | undefined) {
  switch (state) {
    case "live":
      return { text: "transmitindo", cls: "bg-secondary-container/20 text-mint" };
    case "connecting":
      return { text: "negociando…", cls: "bg-surface-container-high text-on-surface-variant" };
    case "stalled":
      return { text: "sem mídia", cls: "bg-error/15 text-error" };
    default:
      return { text: "parada", cls: "bg-surface-container-high text-on-surface-variant" };
  }
}

/**
 * Central de Câmeras — o hub de mídia do design, com os dados reais do
 * tuya-ipc-terminal: fontes RTSP publicadas, estado de mídia por canal e
 * diagnóstico do leitor. Sem PTZ/eventos/detecção: o backend não expõe nada
 * disso, e inventar seria mentir.
 */
export default function CamerasView() {
  const shell = useShell();
  const { devices = [] } = useDevices(shell.auto);
  const { data: cloud } = useCloudStatus();
  const { data: cfg } = useConfig();
  const srcQ = useCamSources();

  const cloudUp = Boolean(cloud?.logged_in || cloud?.rtsp?.alive);
  const cams = devices.filter((d) => d.kind === "cam");
  const sources = useMemo(() => srcQ.data?.sources ?? [], [srcQ.data]);

  // canal primário (hd ou o primeiro) — o mesmo critério do player
  const primary = useMemo(
    () => sources.find((s) => /\/hd$/i.test(s.path ?? "")) ?? sources[0] ?? null,
    [sources],
  );
  const status = useCamStreamStatus(primary?.path ?? "", Boolean(primary), 5000);
  const live = status.data?.streams?.[0];
  const packets = sources.reduce((sum, s) => sum + (s.packets ?? 0), 0);
  const keyframes = sources.reduce((sum, s) => sum + (s.keyframes ?? 0), 0);

  if (!cloudUp) {
    return (
      <div className="mx-auto w-full max-w-[1540px] px-5 py-6">
        <CloudRequired />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-6 px-5 py-6">
      {/* ---- barra de telemetria do servidor de vídeo ---- */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-xl bg-surface-container-low/70 p-4 shadow-md backdrop-blur-md xl:flex-row xl:items-center">
        <div className="flex items-center gap-4">
          <div className="grid size-10 place-items-center rounded-xl bg-primary-container/20 text-primary shadow-[0_0_16px_rgba(6,182,212,0.25)]">
            <Video className="size-6" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-[20px] font-semibold tracking-tight text-on-surface">
                CFTV &amp; Media Hub
              </h1>
              <span className={`${BADGE} bg-mint/15 uppercase text-mint`}>
                tuya-ipc-terminal
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-on-surface-variant">
              <span className="flex items-center gap-1">
                <span
                  className={`size-1.5 rounded-full ${srcQ.data?.alive ? "bg-mint" : "bg-outline"}`}
                />
                Local RTSP: <span className="text-primary">{srcQ.data?.base ?? "—"}</span>
              </span>
              <span className="text-outline-variant">•</span>
              <span>
                Ponte:{" "}
                <span className="text-on-surface">
                  {srcQ.data?.alive ? "no ar" : srcQ.data?.auto ? "subindo sozinha…" : "parada"}
                </span>
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 rounded-lg bg-surface-container px-4 py-1.5">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-outline">Canais</span>
              <span className="font-mono text-[18px] font-semibold text-primary">
                {sources.length}
              </span>
            </div>
            <Satellite className="size-5 text-primary/70" />
          </div>
          <div className="flex items-center gap-3 rounded-lg bg-surface-container px-4 py-1.5">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-outline">RTP</span>
              <span className="font-mono text-[18px] font-semibold text-mint">{packets}</span>
            </div>
            <Activity className="size-5 text-mint" />
          </div>
          <div className="flex items-center gap-3 rounded-lg bg-surface-container px-4 py-1.5">
            <div className="flex flex-col">
              <span className="text-[10px] uppercase tracking-wider text-outline">FPS agora</span>
              <span className="font-mono text-[18px] font-semibold text-primary-fixed-dim">
                {live?.fps ?? "–"}
              </span>
            </div>
            <Radio className="size-5 text-primary" />
          </div>
          <button
            type="button"
            onClick={shell.refreshAll}
            className="flex items-center gap-2 rounded-lg bg-surface-container-high px-3 py-2 text-[12px] font-medium text-on-surface transition-all hover:bg-surface-bright"
          >
            <RefreshCw className="size-4 text-primary" />
            Reconectar
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* ---- palco principal ---- */}
        <div className="flex flex-col gap-5 lg:col-span-8">
          {cams.length > 0 ? (
            cams.map((c) => <CameraCard key={c.id} device={c} />)
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-container-low p-8 text-center">
              <CloudOff className="size-8 text-outline" />
              <p className="text-sm text-on-surface">
                {sources.length > 0
                  ? "a ponte publicou canais, mas nenhuma câmera da lista casou com eles"
                  : "nenhuma câmera na lista ainda — conecte a conta e a ponte sobe sozinha"}
              </p>
              <p className="max-w-md text-[11px] text-on-surface-variant">
                a câmera não tem porta na LAN; o vídeo vem do relay P2P e a ponte
                sobe quando a sessão chega no navegador
              </p>
            </div>
          )}
        </div>

        {/* ---- coluna lateral ---- */}
        <div className="flex flex-col gap-5 lg:col-span-4">
          {/* canais publicados pelo Go */}
          <div className="flex flex-col gap-3 rounded-xl bg-surface-container-low p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[15px] font-semibold text-on-surface">
                <Video className="size-4 text-primary" />
                Canais publicados
              </span>
              <span className="text-[11px] text-on-surface-variant">
                {sources.filter((s) => s.media_state === "live").length} ao vivo
              </span>
            </div>
            {sources.length === 0 && (
              <p className="rounded-lg bg-surface-container p-3 text-[11px] text-on-surface-variant">
                {srcQ.isPending
                  ? "consultando a ponte…"
                  : (srcQ.data?.error || srcQ.data?.log?.split("\n").filter(Boolean).pop() ||
                    "nenhum canal ainda — a ponte sobe quando a sessão chega")}
              </p>
            )}
            {sources.map((s) => {
              const mb = mediaBadge(s.media_state);
              return (
                <div
                  key={s.path}
                  className="flex items-center justify-between gap-2 rounded-xl bg-surface-container p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          s.media_state === "live" ? "bg-mint" : "bg-outline"
                        }`}
                      />
                      <span className="truncate text-[13px] font-medium text-on-surface">
                        {s.name ?? s.path}
                      </span>
                    </div>
                    <span className="block truncate font-mono text-[10px] text-outline">
                      {s.path}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <span className={`${BADGE} ${mb.cls}`}>{mb.text}</span>
                    <span className="font-mono text-[10px] text-on-surface-variant">
                      {s.packets ?? 0} RTP · {s.clients ?? 0} cliente(s)
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* diagnóstico do leitor (frames reais do backend) */}
          <div className="flex flex-col gap-3 rounded-xl bg-surface-container-low p-4 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-[15px] font-semibold text-on-surface">
                <Activity className="size-4 text-mint" />
                Diagnóstico do leitor
              </span>
              <span className="font-mono text-[11px] text-on-surface-variant">
                {primary?.path ?? "sem canal"}
              </span>
            </div>
            {live ? (
              <>
                <div className="grid grid-cols-3 gap-2 rounded-xl bg-surface-container-lowest p-3">
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-outline">Estado</span>
                    <span className="font-mono text-[13px] text-primary">{live.state}</span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-outline">Codec</span>
                    <span className="font-mono text-[13px] text-on-surface">
                      {live.codec || "—"}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-[10px] uppercase text-outline">Frames</span>
                    <span className="font-mono text-[13px] text-mint">
                      {live.frames ?? 0}
                    </span>
                  </div>
                </div>
                {live.history?.length > 0 && (
                  <div className="flex flex-col gap-1 rounded-lg bg-surface-container-lowest p-3 font-mono text-[10px] text-on-surface-variant">
                    {live.history.slice(-4).map((h, i) => (
                      <span key={i} className="truncate">
                        › {h}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="rounded-lg bg-surface-container p-3 text-[11px] text-on-surface-variant">
                sem canal para diagnosticar — abra o stream no palco ao lado
              </p>
            )}
            <div className="flex items-center justify-between text-[10px] text-outline">
              <span>keyframes: {keyframes}</span>
              <span>{cfg?.camera ? `câmera da config: ${cfg.camera.name}` : ""}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
