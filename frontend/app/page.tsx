"use client";

import { Activity, CloudCog, Gauge, RefreshCw, ShieldCheck, Zap } from "lucide-react";
import { useCloudStatus } from "@/hooks/useCloud";
import { useDevices } from "@/hooks/useDevices";
import { useNotify } from "@/lib/query";
import { useShell } from "@/lib/shell";
import BulkBar from "@/components/BulkBar";
import DeviceCard from "@/components/DeviceCard";

/**
 * Dashboard Geral — a ribbon de telemetria real (o que os aparelhos
 * reportam; nada de número decorativo) + a grade completa de módulos.
 */
export default function Dashboard() {
  const notify = useNotify();
  const shell = useShell();
  const {
    devices = [], source, isPending, isFetching, isStale, error, refetch,
  } = useDevices(shell.auto);
  const { data: cloud } = useCloudStatus();

  // Consumo agora: soma só de quem realmente reporta potência. Sem nenhum
  // medidor, nada de "0 W" — um zero falso passaria por medição.
  const measured = devices.filter(
    (d) => typeof d.energy?.potencia_w === "number" && Number.isFinite(d.energy.potencia_w),
  );
  const watts = measured.reduce((sum, d) => sum + (d.energy.potencia_w ?? 0), 0);
  const volts = measured
    .map((d) => d.energy.tensao_v)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const avgVolts = volts.length ? volts.reduce((a, b) => a + b, 0) / volts.length : null;

  const online = devices.filter((d) => d.ok).length;
  const lanCount = devices.filter((d) => d.local).length;
  const cloudCount = devices.filter((d) => d.remote && !d.local).length;

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-6 px-5 py-6">
      {/* ---- ribbon de telemetria + ações globais ---- */}
      <div className="relative">
        <div className="pointer-events-none absolute -top-12 left-1/4 h-44 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -top-16 right-1/4 h-36 w-80 rounded-full bg-mint/10 blur-3xl" />
        <div className="relative flex flex-col items-stretch justify-between gap-4 rounded-2xl bg-surface-container/70 p-4 shadow-xl backdrop-blur-md xl:flex-row xl:items-center">
          <div className="grid grid-cols-1 items-center gap-6 sm:grid-cols-3">
            {/* potência ativa */}
            <div className="flex items-center gap-2.5">
              <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
                <Zap className="size-[22px]" />
              </div>
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-[18px] font-semibold tabular-nums tracking-tight text-on-surface">
                    {measured.length
                      ? watts.toLocaleString("pt-BR", { maximumFractionDigits: 1 })
                      : "–"}
                  </span>
                  <span className="font-mono text-[11px] text-primary">W</span>
                </div>
                <span className="block text-[11px] uppercase tracking-wider text-on-surface-variant">
                  {measured.length ? "Potência ativa" : "Sem medição agora"}
                </span>
              </div>
            </div>
            {/* tensão média */}
            <div className="flex items-center gap-2.5">
              <div className="grid size-10 place-items-center rounded-xl bg-mint/10 text-mint">
                <Gauge className="size-[22px]" />
              </div>
              <div>
                <div className="flex items-baseline gap-1">
                  <span className="font-mono text-[18px] font-semibold tabular-nums tracking-tight text-on-surface">
                    {avgVolts != null
                      ? avgVolts.toLocaleString("pt-BR", { maximumFractionDigits: 1 })
                      : "–"}
                  </span>
                  <span className="font-mono text-[11px] text-mint">V</span>
                </div>
                <span className="block text-[11px] uppercase tracking-wider text-on-surface-variant">
                  {avgVolts != null ? "Rede estável" : "sem leitura"}
                </span>
              </div>
            </div>
            {/* dispositivos */}
            <div className="flex items-center gap-2.5">
              <div className="grid size-10 place-items-center rounded-xl bg-surface-container-high text-on-surface-variant">
                <CloudCog className="size-[22px]" />
              </div>
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[18px] font-semibold leading-none tabular-nums text-on-surface">
                    {devices.length || "–"}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {cloudCount > 0 && (
                      <span className="rounded-full bg-secondary-container/40 px-2 py-0.5 text-[10px] font-bold tracking-wide text-mint">
                        {cloudCount} NUVEM
                      </span>
                    )}
                    {lanCount > 0 && (
                      <span className="rounded-full bg-primary-container/30 px-2 py-0.5 text-[10px] font-bold tracking-wide text-primary">
                        {lanCount} LAN
                      </span>
                    )}
                  </div>
                </div>
                <span className="block text-[11px] uppercase tracking-wider text-on-surface-variant">
                  {online} online agora
                </span>
              </div>
            </div>
          </div>

          {/* ação global */}
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <div className="hidden items-center gap-1.5 rounded-xl bg-surface-container-lowest px-3 py-1.5 text-[11px] text-on-surface-variant md:flex">
              <Activity className="size-3.5 text-primary" />
              <span>
                lista:{" "}
                <strong className="font-mono text-on-surface">
                  {source?.source === "cloud"
                    ? "conta (nuvem)"
                    : source?.source === "chaves"
                      ? "cofre local"
                      : "vazio"}
                </strong>
                {source ? ` · ${source.lan_devices} na LAN` : ""}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                shell.refreshAll();
                refetch().then(() => notify("atualizado", "ok"));
              }}
              disabled={isFetching}
              title="Atualizar tudo (lista, conta, câmera, IR)"
              aria-label="Atualizar tudo"
              className="grid size-9 place-items-center rounded-xl bg-surface-container-high text-on-surface transition-colors hover:bg-surface-bright disabled:opacity-60"
            >
              <RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
            </button>
            <BulkBar devices={devices} />
          </div>
        </div>
      </div>

      {/* ---- avisos honestos ---- */}
      {devices.length === 0 && cloud?.logged_in && (
        <p className="rounded-xl border border-tertiary/30 bg-tertiary-container/10 px-4 py-3 text-sm text-tertiary">
          Nenhum aparelho visível. Se a conta está conectada mas o navegador não
          tem chaves, importe o backup em{" "}
          <span className="font-medium text-on-surface">Inventário &amp; Chaves Tuya</span>.
        </p>
      )}
      {error && (
        <p className="rounded-xl border border-error/30 bg-error/10 px-4 py-2.5 text-sm text-error">
          backend fora do ar: {String(error)}
        </p>
      )}
      {isStale && (
        <p className="text-[11px] text-tertiary">
          estado em cache do backend — consultando cada aparelho na rede (pode levar ~45s)…
        </p>
      )}

      {/* ---- grade de módulos ---- */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {isPending && devices.length === 0
          ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="skel h-56" />)
          : devices.map((d) => <DeviceCard key={d.id} d={d} />)}
      </div>

      {devices.length === 0 && !isPending && !error && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          nada encontrado ainda — use <span className="text-on-surface">LAN Discovery</span> no
          topo ou conecte a conta em Inventário &amp; Chaves Tuya.
        </p>
      )}

      {/* ---- rodapé do design: integridade do cofre + topologia ---- */}
      {devices.length > 0 && (
        <div className="mt-2 flex w-full flex-col items-center justify-between gap-4 rounded-2xl bg-surface-container-low/60 p-4 md:flex-row">
          <div className="flex items-center gap-2.5 text-[11px] text-on-surface-variant">
            <ShieldCheck className="size-4 text-primary" />
            <span>
              Cofre local sincronizado · chaves Tuya carregadas do navegador a
              cada requisição (o backend não guarda nada)
            </span>
          </div>
          <div className="flex items-center gap-4 font-mono text-[11px] text-on-surface-variant">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-mint" />
              {cloudCount} nuvem
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" />
              {lanCount} LAN
            </span>
            <span className="hidden text-outline sm:inline">
              {measured.length} medindo energia
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
