"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, EyeOff, Globe2, RefreshCw, Ruler, Thermometer, Zap } from "lucide-react";
import { extEnergy, fmtW, type EnergyRow } from "@/lib/ext/energy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";

/* ------------------------------------------------------------- auxiliares -- */

function Bar({ w, max }: { w: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((w / max) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-500" />
      <span>{text}</span>
    </p>
  );
}

function Loading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <RefreshCw className="size-3.5 animate-spin" />
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- energia -- */

function EnergyRow_({ row, max }: { row: EnergyRow; max: number }) {
  const e = row.energy ?? {};
  const w = typeof e.potencia_w === "number" ? e.potencia_w : null;
  const v = typeof e.tensao_v === "number" ? e.tensao_v : null;
  const a = typeof e.corrente_ma === "number" ? e.corrente_ma : null;
  return (
    <div className="space-y-1.5 border-b py-2.5 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium">{row.name || row.id}</span>
        <span className="shrink-0 font-mono text-sm tabular-nums">
          {w === null ? (
            <span className="text-muted-foreground">sem leitura</span>
          ) : (
            fmtW(w)
          )}
        </span>
      </div>
      <Bar w={w ?? 0} max={max} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="font-mono tabular-nums">
          tensao_v {v ?? "—"}
        </span>
        <span className="font-mono tabular-nums">
          corrente_ma {a ?? "—"}
        </span>
        <span className="font-mono">{row.local ? "LAN" : row.remote ? "nuvem" : "offline"}</span>
        {row.error && <span className="text-amber-600">{row.error}</span>}
      </div>
    </div>
  );
}

function EnergyCard() {
  const q = useQuery({ queryKey: ["ext", "energy", "summary"], queryFn: extEnergy.summary });

  if (q.isPending) return <Loading>medindo tomadas…</Loading>;
  if (q.isError) return <ErrorNote text={q.error.message} />;

  const d = q.data;
  if (!d?.ok) return <ErrorNote text={d?.error || "sem dados"} />;

  const rows = d.rows ?? [];
  const max = Math.max(...rows.map((r) => r.energy?.potencia_w ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="flex items-center gap-1.5 text-xs">
              <Zap className="size-3.5" /> potencia_w total
            </CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">{fmtW(d.total_w)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">tensao_v (maior)</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {d.total_v ? `${d.total_v} V` : "—"}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">tomadas lendo</CardDescription>
            <CardTitle className="font-mono text-2xl tabular-nums">
              {d.reporting}/{d.devices}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Energia por dispositivo</CardTitle>
          <CardDescription className="text-xs">{d.source_note}</CardDescription>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              nenhuma tomada com DPS de energia
            </p>
          ) : (
            rows.map((r) => <EnergyRow_ key={r.id} row={r} max={max} />)
          )}
        </CardContent>
      </Card>

      {d.source_rejected?.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">APIs de energia rejeitadas</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {d.source_rejected.map((r) => (
              <div key={r.api} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono">{r.api}</span>
                <Badge variant="outline" className="font-mono text-[10px]">v{r.versions}</Badge>
                <span className="font-mono text-amber-600">{r.error}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- unidades -- */

function UnitsCard() {
  const [q, setQ] = useState("");
  const rq = useQuery({ queryKey: ["ext", "energy", "units"], queryFn: extEnergy.units });

  if (rq.isPending) return <Loading>buscando unidades…</Loading>;
  if (rq.isError) return <ErrorNote text={rq.error.message} />;

  const u = rq.data;
  if (!u?.ok) return <ErrorNote text="sem dados" />;

  const needle = q.trim().toLowerCase();
  const countries = (u.countries?.list ?? [])
    .filter((c) => !needle || (c.name ?? "").toLowerCase().includes(needle))
    .slice(0, 50);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Thermometer className="size-4" /> Temperatura
          </CardTitle>
          <CardDescription className="text-xs">{u.temperature.source}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {u.temperature.available ? (
            u.temperature.rules.map((rule, i) => (
              <div key={i} className="rounded-lg border p-3">
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-mono">{rule.from.join(" / ")}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="font-mono">{rule.to.join(" / ")}</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {rule.rules.map((step, j) => (
                    <Badge key={j} variant="secondary" className="font-mono text-[11px]">
                      {step.action} {step.value}
                    </Badge>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">a API não devolveu regras</p>
          )}
          <ErrorNote text={u.temperature.note} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Ruler className="size-4" /> Distância e energia/peso
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {([u.distance, u.energy_weight] as const).map((slot) => (
            <div key={slot === u.distance ? "d" : "e"} className="rounded-lg border p-3">
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="font-medium">
                  {slot === u.distance ? "Distância" : "Energia / peso"}
                </span>
                <Badge variant="outline" className="text-[10px]">não devolvido</Badge>
              </div>
              <p className="text-xs text-muted-foreground">{slot.note}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe2 className="size-4" /> Região e países
          </CardTitle>
          <CardDescription className="text-xs">
            conta em <span className="font-mono">{u.region.account || "—"}</span>
            {u.region.alias && <> → <span className="font-mono">{u.region.alias.region}</span> ({u.region.alias.alias})</>}
            {" · "}{u.countries?.count ?? 0} países na lista
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {u.region.list.map((r) => (
              <Badge key={r.region} variant="secondary" className="font-mono text-[11px]">
                {r.region} · {r.alias}
              </Badge>
            ))}
          </div>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filtrar país…"
            className="h-9"
          />
          <div className="max-h-56 overflow-y-auto text-sm">
            {countries.length === 0 ? (
              <p className="py-4 text-center text-muted-foreground">nada encontrado</p>
            ) : (
              countries.map((c) => (
                <div key={c.code2} className="flex items-center gap-3 border-b py-1.5 last:border-0">
                  <span className="w-10 shrink-0 font-mono text-xs">{c.code2}</span>
                  <span className="flex-1 truncate">{c.name}</span>
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">
                    +{c.calling}
                  </span>
                  <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">
                    {c.continent}
                  </span>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- inventário -- */

function HiddenCard() {
  const q = useQuery({ queryKey: ["ext", "energy", "hidden"], queryFn: extEnergy.hidden });

  if (q.isPending) return <Loading>procurando devices ocultos…</Loading>;
  if (q.isError) return <ErrorNote text={q.error.message} />;

  const d = q.data;
  if (!d?.ok) return <ErrorNote text="sem dados" />;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <EyeOff className="size-4" /> Dispositivos ocultos do home
        </CardTitle>
        <CardDescription className="text-xs">{d.note}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {d.count === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            nenhum dispositivo oculto em {d.homes.length} home(s)
          </p>
        ) : (
          d.devices.map((dev) => (
            <div
              key={`${dev.gid}-${dev.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-0"
            >
              <span className="truncate text-sm font-medium">
                {dev.name || dev.id}
              </span>
              <span className="font-mono text-xs text-muted-foreground">{dev.id}</span>
              <Badge variant="outline" className="font-mono text-[10px]">
                bizType {dev.bizType ?? "—"}
              </Badge>
              {dev.name_from === "none" && (
                <Badge variant="secondary" className="text-[10px]">fora do bundle</Badge>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{dev.home}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/* ----------------------------------------------------------------- painel -- */

export default function ExtEnergyPanel() {
  const [tick, setTick] = useState(0);
  const all = useQuery({
    queryKey: ["ext", "energy", "tick", tick],
    queryFn: async () => {
      const [summary, units, hidden] = await Promise.all([
        extEnergy.summary(),
        extEnergy.units(),
        extEnergy.hidden(),
      ]);
      return { summary, units, hidden };
    },
  });

  const busy = all.isFetching;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Energia, unidades e inventário</h2>
          <p className="text-xs text-muted-foreground">
            gateway móvel Tuya · o que a API devolveu, sem número inventado
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setTick((t) => t + 1)}
        >
          <RefreshCw className={busy ? "size-3.5 animate-spin" : "size-3.5"} />
          Atualizar
        </Button>
      </div>

      <EnergyCard />
      <UnitsCard />
      <HiddenCard />
    </div>
  );
}
