"use client";

import { useState } from "react";
import { Loader2, Minus, Plus, Radio, RefreshCw, Zap } from "lucide-react";
import type { Device } from "@/lib/api";
import { deviceStatus } from "@/lib/device-status";
import { useNotify } from "@/lib/query";
import { useControl, useDeviceStatus } from "@/hooks/useDevices";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import ColorPicker, { colorFromDps, hexToRgb } from "./ColorPicker";
import { DeviceIcon } from "./DeviceIcon";

export const KIND_LABEL: Record<string, string> = {
  bulb: "Lâmpada",
  plug: "Tomada",
  ir: "Infravermelho",
  cam: "Câmera",
  cloud: "Nuvem",
};

/** Título do badge de estado, no tom do design. */
function statusBadgeClass(label: string): string {
  if (label === "ligado" || label === "online") return "bg-primary/20 text-primary";
  if (label === "desligado") return "bg-surface-container-highest text-on-surface-variant";
  if (label === "offline") return "bg-error/15 text-error";
  if (label === "nuvem") return "bg-tertiary-container/15 text-tertiary";
  return "bg-surface-container-high text-on-surface-variant";
}

/** Stepper numérico: o <input type=number> nativo é o calcanhar de Aquiles da UI. */
function Stepper({
  value, onChange, min, max, step = 1, suffix,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
}) {
  const clamp = (v: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="flex items-center gap-1.5 rounded-xl bg-surface-container-high p-1">
      <button
        type="button"
        onClick={() => onChange(clamp(value - step))}
        aria-label="diminuir"
        className="grid size-8 place-items-center rounded-lg bg-surface-container text-on-surface transition-all hover:bg-surface-bright active:scale-95"
      >
        <Minus className="size-3.5" />
      </button>
      <div className="relative">
        <Input
          type="number"
          inputMode="numeric"
          value={Number.isFinite(value) ? value : min}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(clamp(Number(e.target.value) || min))}
          className="h-8 w-20 border-0 bg-transparent pr-9 text-center font-mono text-sm tabular-nums shadow-none focus-visible:ring-0"
        />
        {suffix && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-on-surface-variant">
            {suffix}
          </span>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(clamp(value + step))}
        aria-label="aumentar"
        className="grid size-8 place-items-center rounded-lg bg-surface-container text-on-surface transition-all hover:bg-surface-bright active:scale-95"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}

function SliderField({
  label, value, onChange, min = 0, max = 100, format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  format?: (v: number) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-on-surface-variant">
          {label}
        </span>
        <span className="font-mono text-[11px] font-semibold tabular-nums text-primary">
          {format ? format(value) : value}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}

export default function DeviceCard({ d }: { d: Device }) {
  const notify = useNotify();
  const control = useControl();
  const refreshOne = useDeviceStatus();
  const busyAction =
    control.isPending && control.variables?.id === d.id
      ? String(control.variables?.action ?? "")
      : null;
  const refreshing = refreshOne.isPending && refreshOne.variables === d.id;

  // override local enquanto o usuário mexe; o valor real vem do DPS
  const dpsBr = Number(d.dps["22"] ?? 500);
  const dpsTp = Number(d.dps["23"] ?? 500);
  const dpsCd = Math.round(Number(d.dps["9"] ?? 0) / 60);
  const [brOverride, setBrOverride] = useState<number | null>(null);
  const [tpOverride, setTpOverride] = useState<number | null>(null);
  const [cdOverride, setCdOverride] = useState<number | null>(null);
  // cor escolhida no picker; sem escolha, mostra a cor que o DP 24 reporta
  const [colorOverride, setColorOverride] = useState<string | null>(null);
  const color = colorOverride ?? colorFromDps(d.dps) ?? "#ffd166";

  const br = brOverride ?? dpsBr;
  const tp = tpOverride ?? dpsTp;
  const cd = cdOverride ?? dpsCd;

  async function run(action: string, params: Record<string, string | number> = {}, label?: string) {
    try {
      const r = await control.mutateAsync({ id: d.id, action, params });
      if (r.ok) {
        setBrOverride(null);
        setTpOverride(null);
        setCdOverride(null);
        notify(label ?? "comando enviado", "ok");
      } else notify(r.error ?? "falhou", "err");
    } catch (e) {
      notify(`falha de rede: ${e}`, "err");
    }
  }

  // Rótulo e cor vêm de lib/device-status: a tabela usa a MESMA função, para
  // o mesmo aparelho nunca aparecer "offline" numa visão e vivo na outra.
  const st = deviceStatus(d);
  const iconTone =
    d.kind === "ir"
      ? "bg-surface-container-high text-tertiary"
      : d.kind === "plug"
        ? "bg-mint/10 text-mint group-hover:bg-secondary-container group-hover:text-on-secondary"
        : d.kind === "cam"
          ? "bg-primary/10 text-primary group-hover:bg-primary-container group-hover:text-on-primary"
          : st.icon === "off"
            ? "bg-surface-container-high text-on-surface-variant"
            : "bg-primary/10 text-primary group-hover:bg-primary-container group-hover:text-on-primary";

  return (
    <div
      className={`device-card group flex flex-col justify-between rounded-2xl bg-surface-container-low p-4 shadow-lg transition-all duration-200 hover:bg-surface-container/90 ${
        !d.ok && st.label === "offline" ? "opacity-80" : ""
      }`}
      data-status={st.label}
    >
      <div className="flex flex-col gap-4">
        {/* topo: ícone + nome + tipo + status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div
              className={`grid size-10 shrink-0 place-items-center rounded-xl transition-colors ${iconTone}`}
            >
              <DeviceIcon kind={d.kind} className="size-[22px]" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[15px] font-semibold leading-none tracking-tight text-on-surface">
                {d.name}
              </h2>
              <span className="mt-1 flex items-center gap-1.5 text-[11px] text-on-surface-variant">
                <span
                  className={`size-1.5 shrink-0 rounded-full ${
                    !d.ok ? "bg-outline" : d.on ? "bg-mint" : "bg-outline"
                  }`}
                />
                <span className="truncate">
                  {d.local ? "LAN direto" : d.remote ? "via nuvem" : d.ip ? "na rede" : "sem IP"} ·{" "}
                  {KIND_LABEL[d.kind] ?? d.kind}
                </span>
              </span>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${statusBadgeClass(st.label)}`}
          >
            {st.label}
          </span>
        </div>

        {/* aviso de caminho do comando (honesto: fora da LAN vai pela nuvem) */}
        {!d.local && d.remote && (
          <div className="flex items-center gap-1.5 rounded-lg bg-surface-container-lowest px-2.5 py-1.5 text-[11px] text-on-surface-variant">
            <span className="text-primary">
              <DeviceIcon kind={d.kind} className="size-3.5" />
            </span>
            <span>Fora da LAN — o comando vai pela nuvem, como no app.</span>
          </div>
        )}

        <div className="flex flex-col gap-4">
          {d.local || d.remote ? (
            <>
              {d.kind === "ir" ? (
                <p className="flex items-start gap-2 rounded-lg bg-surface-container-lowest px-3 py-2 text-xs leading-relaxed text-on-surface-variant">
                  <Radio className="mt-px size-3.5 shrink-0 text-tertiary" />
                  <span>
                    Blaster IR — os botões do controle ficam em{" "}
                    <span className="text-foreground">IR &amp; Controle</span>.
                  </span>
                </p>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!!busyAction || refreshing}
                    onClick={() => run("toggle")}
                    className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-medium transition-all active:scale-[0.98] disabled:opacity-70 ${
                      d.ok && d.on
                        ? "bg-primary text-on-primary shadow-[0_0_16px_rgba(76,215,246,0.3)] hover:bg-primary-fixed-dim"
                        : "bg-surface-container-high text-on-surface hover:bg-primary hover:text-on-primary"
                    }`}
                  >
                    {busyAction === "toggle" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Zap className="size-4" />
                    )}
                    Ligar / Desligar
                  </button>
                  <button
                    type="button"
                    disabled={!!busyAction || refreshing}
                    onClick={() =>
                      refreshOne.mutate(d.id, { onError: (e) => notify(`falha: ${e}`, "err") })
                    }
                    title="Sincronizar estado"
                    aria-label="Sincronizar estado"
                    className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-container-high text-on-surface-variant transition-colors hover:bg-surface-bright hover:text-on-surface"
                  >
                    {refreshing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <RefreshCw className="size-4" />
                    )}
                  </button>
                </div>
              )}

              {d.kind === "bulb" && (
                <>
                  <SliderField
                    label="Brilho"
                    value={br}
                    min={10}
                    max={1000}
                    onChange={setBrOverride}
                    format={(v) => `${Math.round((v / 1000) * 100)}%`}
                  />
                  <div className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] uppercase tracking-wider text-on-surface-variant">
                        Temperatura
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-tertiary">
                        {tp}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex-1">
                        <Slider value={[tp]} min={0} max={1000} step={1} onValueChange={([v]) => setTpOverride(v)} />
                      </div>
                      <button
                        type="button"
                        disabled={!!busyAction}
                        onClick={() => run("temp", { value: tp }, `temperatura ${tp}`)}
                        className="rounded-lg bg-surface-container-high px-2.5 py-1 text-[11px] font-medium text-on-surface transition-colors hover:bg-surface-bright disabled:opacity-60"
                      >
                        Aplicar
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <div className="flex items-center gap-2">
                      <ColorPicker
                        color={color}
                        onColorChange={setColorOverride}
                        onApply={() => {
                          const rgb = hexToRgb(color);
                          if (rgb) void run("color", rgb, "cor aplicada");
                        }}
                        disabled={!!busyAction}
                        applying={busyAction === "color"}
                      />
                      <div className="rounded-md bg-surface-container-highest px-2 py-0.5 font-mono text-[11px] text-on-surface uppercase">
                        {color}
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={!!busyAction}
                      onClick={() => run("white", {}, "modo branco")}
                      className="rounded-lg bg-surface-container-high px-2.5 py-1 text-[11px] font-medium text-on-surface transition-colors hover:bg-surface-bright disabled:opacity-60"
                    >
                      Branco
                    </button>
                  </div>
                </>
              )}

              {d.kind === "plug" && (
                <>
                  <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-[13px] text-on-surface-variant">Desliga em</span>
                    <Stepper
                      value={cd}
                      min={0}
                      max={1440}
                      step={5}
                      suffix="min"
                      onChange={setCdOverride}
                    />
                  </div>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      disabled={!!busyAction || cd === 0}
                      onClick={() => run("countdown", { value: cd * 60 }, `desliga em ${cd} min`)}
                      className="w-full rounded-xl bg-surface-container-high/60 py-1.5 text-[11px] text-on-surface-variant transition-colors hover:bg-surface-container-high disabled:opacity-50"
                    >
                      {cd ? `Programar ${cd} min` : "Programar desligamento"}
                    </button>
                    {dpsCd > 0 && (
                      <button
                        type="button"
                        disabled={!!busyAction}
                        onClick={() => {
                          setCdOverride(0);
                          void run("countdown", { value: 0 }, "timer cancelado");
                        }}
                        className="w-full rounded-xl bg-surface-container-high/60 py-1.5 text-[11px] text-on-surface-variant transition-colors hover:bg-surface-container-high"
                      >
                        Cancelar timer
                      </button>
                    )}
                  </div>

                  {(d.energy.potencia_w != null || d.energy.tensao_v != null) && (
                    <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-container-lowest p-2">
                      {(
                        [
                          [d.energy.potencia_w, "W", "potência", true],
                          [d.energy.tensao_v, "V", "tensão", false],
                          [d.energy.corrente_ma, "mA", "corrente", false],
                        ] as const
                      ).map(([val, unit, label, hot]) => (
                        <div key={unit} className="flex flex-col items-center justify-center p-1">
                          <div className="flex items-baseline gap-0.5">
                            <span
                              className={`font-mono text-[17px] font-bold tabular-nums ${
                                val == null
                                  ? "text-on-surface-variant"
                                  : hot
                                    ? "text-primary"
                                    : unit === "mA"
                                      ? "text-mint"
                                      : "text-on-surface"
                              }`}
                            >
                              {val ?? "–"}
                            </span>
                            <span className="text-[10px] text-on-surface-variant">{unit}</span>
                          </div>
                          <span className="mt-0.5 text-[10px] uppercase tracking-wider text-on-surface-variant">
                            {label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}

              {d.kind !== "bulb" && d.kind !== "plug" && d.kind !== "ir" && (
                <p className="rounded-xl bg-surface-container-lowest p-3 text-center text-[11px] text-on-surface-variant">
                  Status apenas — este tipo não tem ação local direta.
                </p>
              )}
            </>
          ) : d.kind === "cam" && d.ok ? (
            // Câmera online: a nota é EXPLICAÇÃO (por que não há botão de
            // ligar), não aviso — caixa âmbar aqui parecia erro.
            <p className="rounded-xl bg-surface-container-lowest p-3 text-[11px] leading-relaxed text-on-surface-variant">
              {d.note ?? "vídeo via P2P — sem DPS de controle"}
            </p>
          ) : (
            <p className="rounded-xl bg-tertiary-container/10 p-3 text-[11px] leading-relaxed text-tertiary">
              {d.note ?? "sem controle"}
            </p>
          )}
        </div>
      </div>

      {/* rodapé: metadados, como no design */}
      <div className="mt-4 flex items-center justify-between pt-3 text-[11px] text-on-surface-variant/70">
        <span className="flex items-center gap-1.5">
          <span
            className={`size-1.5 rounded-full ${
              !d.ok ? "bg-outline" : d.on ? "bg-mint" : "bg-outline"
            }`}
          />
          {d.ok
            ? d.kind === "cam"
              ? "vídeo P2P"
              : d.kind === "ir"
                ? "comando pela nuvem"
                : "pronto"
            : (d.error ?? "sem resposta")}
        </span>
        <span className="truncate font-mono">{d.id.slice(0, 10)}…</span>
      </div>
    </div>
  );
}
