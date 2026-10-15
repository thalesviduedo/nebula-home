"use client";

import { Radar, RefreshCw, ShieldCheck, CloudOff } from "lucide-react";
import Logo from "@/components/Logo";
import { useCloudStatus } from "@/hooks/useCloud";
import { useDevices } from "@/hooks/useDevices";
import { useShell } from "@/lib/shell";
import { useNotify } from "@/lib/query";

/**
 * Topbar fixa do design (h-16): identidade, saúde do sistema e os controles
 * globais — descoberta LAN, auto-refresh e sincronização. Os números vêm da
 * lista real (cache rápido ~4ms); nada aqui é decorativo.
 */
export default function Header() {
  const notify = useNotify();
  const shell = useShell();
  const { devices = [], source, isFetching, refetch, isStale } = useDevices(shell.auto);
  const { data: cloud } = useCloudStatus(15_000);

  const online = devices.filter((d) => d.ok).length;
  const cloudUp = Boolean(cloud?.logged_in || cloud?.rtsp?.alive);

  return (
    <header className="fixed inset-x-0 top-0 z-50 h-16 bg-surface/85 shadow-[0_1px_8px_rgba(0,0,0,0.35)] backdrop-blur-xl">
      <div className="flex h-full w-full items-center justify-between px-5">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <Logo className="size-9" />
            <span className="text-[20px] font-bold uppercase tracking-tight">
              <span className="text-on-surface">Nebula</span>
              <span className="ml-1 bg-gradient-to-r from-[#22d3ee] via-[#3b82f6] to-[#8b5cf6] bg-clip-text text-transparent">
                Home
              </span>
            </span>
          </div>

          <div className="hidden items-center gap-2 xl:flex">
            <div className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1">
              <span
                className={`size-2 rounded-full ${
                  online > 0 ? "animate-pulse bg-mint" : "bg-outline"
                }`}
              />
              <span className="text-[11px] text-mint">
                {devices.length ? `${online} Online` : "sem dados"}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1">
              {cloudUp ? (
                <ShieldCheck className="size-3.5 text-primary" />
              ) : (
                <CloudOff className="size-3.5 text-outline" />
              )}
              <span className="text-[11px] text-on-surface-variant">
                {cloudUp ? "Cofre Sync OK" : "Sem sessão Tuya"}
              </span>
            </div>
            {isStale && (
              <div className="flex items-center gap-1.5 rounded-full bg-surface-container-high px-3 py-1">
                <RefreshCw className="size-3.5 animate-spin text-tertiary" />
                <span className="text-[11px] text-tertiary">consultando a rede…</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-2 md:flex">
            <button
              type="button"
              onClick={shell.doScan}
              disabled={shell.scanning}
              className="flex items-center gap-1.5 rounded-lg bg-surface-container-high px-3 py-1.5 text-on-surface transition-all hover:bg-surface-bright disabled:opacity-60"
            >
              <Radar
                className={`size-4 text-primary ${shell.scanning ? "animate-spin" : ""}`}
              />
              <span className="text-[11px] font-medium">
                {shell.scanning ? "Varrendo…" : "LAN Discovery"}
              </span>
            </button>

            <button
              type="button"
              onClick={shell.toggleAuto}
              className="flex items-center gap-2 rounded-lg bg-surface-container-low px-3 py-1.5 text-on-surface-variant transition-colors hover:bg-surface-container-high"
              aria-pressed={shell.auto}
              title="renova a lista a cada 30s"
            >
              <span className="text-[11px]">Auto {shell.auto ? "30s" : "off"}</span>
              <span
                className={`relative h-4 w-7 rounded-full transition-colors ${
                  shell.auto ? "bg-mint" : "bg-surface-variant"
                }`}
              >
                <span
                  className={`absolute top-0.5 size-3 rounded-full bg-on-secondary shadow-sm transition-all ${
                    shell.auto ? "right-0.5" : "left-0.5"
                  }`}
                />
              </span>
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              refetch().then(() => notify("lista atualizada", "ok"))
            }
            disabled={isFetching}
            className="grid size-8 place-items-center rounded-lg bg-surface-container text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface disabled:opacity-60"
            title={
              source
                ? `fonte: ${
                    source.source === "cloud"
                      ? "conta (nuvem)"
                      : source.source === "chaves"
                        ? "cofre local"
                        : "vazio — reconecte a conta ou importe o backup"
                  } · ${source.lan_devices} na LAN`
                : "atualizar"
            }
          >
            <RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
          </button>

          <div
            className="grid size-8 place-items-center rounded-full bg-primary"
            title={source?.source === "cloud" ? "lista vinda da conta" : "lista vinda do cofre local"}
          >
            <ShieldCheck className="size-4 text-on-primary" />
          </div>
        </div>
      </div>
    </header>
  );
}
