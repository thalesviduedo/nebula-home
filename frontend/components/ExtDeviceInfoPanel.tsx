"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown, CircleAlert, Cpu, Layers, Loader2, RefreshCw, Search, Waypoints,
} from "lucide-react";
import {
  deviceDetail,
  dpRange,
  formatValue,
  isNumeric,
  KIND_LABEL,
  type AbilityResponse,
  type DpEntry,
  type FirmwareResponse,
  type RawResponse,
  type SchemaResponse,
} from "@/lib/ext/device";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardFooter, CardHeader,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Como a Tuya nomeia os tipos de propriedade de um DP. */
const KIND_HINT: Record<string, string> = {
  bool: "ligado/desligado",
  value: "inteiro com faixa",
  enum: "uma opção da lista",
  string: "texto livre",
  raw: "blob base64",
  bitmap: "bandeiras em bits",
  undeclared: "respondeu sem estar no schema",
};

const MODE_LABEL: Record<string, string> = {
  rw: "leitura e escrita",
  ro: "só leitura",
  wr: "só escrita",
};

function usePanelQueries(id: string, refetchMs = 0) {
  const every = refetchMs > 0 ? refetchMs : false;
  return {
    schema: useQuery({
      queryKey: ["ext-device", "schema", id],
      queryFn: () => deviceDetail.schema(id),
      enabled: !!id,
      staleTime: 120_000,
      refetchInterval: every,
    }),
    ability: useQuery({
      queryKey: ["ext-device", "ability", id],
      queryFn: () => deviceDetail.ability(id),
      enabled: !!id,
      staleTime: 120_000,
      refetchInterval: every,
    }),
    firmware: useQuery({
      queryKey: ["ext-device", "firmware", id],
      queryFn: () => deviceDetail.firmware(id),
      enabled: !!id,
      staleTime: 120_000,
      refetchInterval: every,
    }),
    raw: useQuery({
      queryKey: ["ext-device", "raw", id],
      queryFn: () => deviceDetail.raw(id),
      enabled: !!id,
      staleTime: 30_000,
      refetchInterval: every,
    }),
  };
}

/** Mensagem única para sessão ausente, erro de gateway ou carregando. */
function Problem({
  query, children,
}: {
  query: { isPending: boolean; isError: boolean; error: Error | null; data?: { ok?: boolean; error?: string; needsLogin?: boolean } };
  children: React.ReactNode;
}) {
  if (query.isPending) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> consultando o gateway móvel…
      </p>
    );
  }
  if (query.isError) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-2.5 text-xs text-rose-300">
        <CircleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{String(query.error?.message ?? query.error)}</span>
      </p>
    );
  }
  const data = query.data;
  if (data && data.ok === false) {
    return (
      <p className="flex items-center gap-2 rounded-lg bg-amber-400/10 px-3 py-2.5 text-xs text-amber-300">
        <CircleAlert className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">
          {data.needsLogin ? "sem sessão de nuvem — entre na conta" : data.error}
        </span>
      </p>
    );
  }
  return <>{children}</>;
}

function Kv({ k, v, mono = false }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-muted-foreground">{k}</span>
      <span
        className={`min-w-0 truncate text-right text-xs ${mono ? "font-mono tabular-nums" : ""}`}
        title={typeof v === "string" ? v : undefined}
      >
        {v}
      </span>
    </div>
  );
}

function Json({ value, rows = 18 }: { value: unknown; rows?: number }) {
  return (
    <pre
      className="max-h-96 overflow-auto rounded-lg border border-border/60 bg-background/60 p-3 font-mono text-[11px] leading-relaxed text-foreground/80"
      style={{ maxHeight: `${rows * 1.15}rem` }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * Controle genérico derivado do schema: é o que o painel inteiro poderia
 * virar. Aqui é só a prévia -- o escopo deste módulo é leitura, então nada
 * é enviado de volta ao aparelho.
 */
function DpControl({ dp }: { dp: DpEntry }) {
  const range = dpRange(dp);
  const number = Number(dp.value);

  if (dp.kind === "bool") {
    return (
      <div className="flex items-center justify-end gap-2">
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {formatValue(dp.value)}
        </span>
        <Switch checked={Boolean(dp.value)} disabled />
      </div>
    );
  }

  if (dp.kind === "enum" && Array.isArray(dp.range)) {
    // Radix recusa value="" — um enum com opção vazia quebraria o painel
    const options = dp.range.map((v) => String(v));
    const current = String(dp.value ?? "");
    return (
      <Select value={options.includes(current) ? current : undefined} disabled>
        <SelectTrigger className="h-8 w-full text-xs">
          <SelectValue placeholder={current || "sem valor"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((v) => (
            <SelectItem key={v} value={v} className="text-xs">
              {v || "(vazio)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (dp.kind === "bitmap" && Array.isArray(dp.labels)) {
    const bits = Number(dp.value) || 0;
    return (
      <div className="flex flex-wrap justify-end gap-1">
        {dp.labels.map((label, i) => {
          const on = (bits >> i) & 1;
          return (
            <Badge
              key={`${label}-${i}`}
              variant={on ? "destructive" : "outline"}
              className="font-mono text-[10px]"
            >
              {label}
            </Badge>
          );
        })}
      </div>
    );
  }

  if (range && Number.isFinite(number)) {
    return (
      <div className="flex items-center gap-2">
        <Slider
          className="flex-1"
          value={[Math.min(range.max, Math.max(range.min, number))]}
          min={range.min}
          max={range.max}
          step={range.step}
          disabled
        />
        <span className="w-24 shrink-0 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
          {number}
          {dp.unit ? ` ${dp.unit}` : ""}
        </span>
      </div>
    );
  }

  if (isNumeric(dp.kind)) {
    return (
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatValue(dp.value)}
        {dp.unit ? ` ${dp.unit}` : ""}
      </span>
    );
  }

  return (
    <Input
      readOnly
      value={formatValue(dp.value)}
      className="h-8 font-mono text-[11px]"
    />
  );
}

function DpCard({ dp }: { dp: DpEntry }) {
  const [open, setOpen] = useState(false);
  const range = dpRange(dp);
  const title = dp.label || dp.name || dp.code || `DP ${dp.id}`;

  return (
    <li className="space-y-2.5 rounded-lg border border-border/60 bg-background/40 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            <span className="font-mono text-[11px] tabular-nums text-primary">
              #{dp.id}
            </span>
            <span className="truncate">{title}</span>
          </p>
          <p className="truncate font-mono text-[10px] text-muted-foreground">
            {dp.code || "(sem code)"}
            {dp.name && dp.label && dp.name !== dp.label ? ` · ${dp.name}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge variant="outline" className="font-mono text-[10px]">
            {KIND_LABEL[dp.kind] ?? dp.kind}
          </Badge>
          <Badge
            variant={dp.readOnly ? "secondary" : "default"}
            className="text-[10px]"
            title={MODE_LABEL[dp.mode] ?? dp.mode}
          >
            {dp.mode || "?"}
          </Badge>
          {dp.isSwitch && <Badge variant="outline" className="text-[10px]">principal</Badge>}
        </div>
      </div>

      <DpControl dp={dp} />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        <span title={KIND_HINT[dp.kind] ?? ""}>
          {KIND_HINT[dp.kind] ?? dp.kind}
        </span>
        {range && (
          <span className="font-mono">
            {range.min}…{range.max} passo {range.step}
            {dp.scale ? ` ×10^${dp.scale}` : ""}
          </span>
        )}
        {dp.maxlen != null && <span className="font-mono">máx {dp.maxlen}</span>}
        {dp.kind === "enum" && Array.isArray(dp.range) && (
          <span>{dp.range.length} opções</span>
        )}
        {dp.readOnly && <span>só leitura</span>}
        {!dp.hasValue && <span className="text-amber-400/80">sem valor agora</span>}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-5 px-1.5 text-[10px]"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown className={`size-3 transition-transform ${open ? "rotate-180" : ""}`} />
          cru
        </Button>
      </div>

      {open && <Json value={{ ...dp, property: dp.property }} rows={10} />}
    </li>
  );
}

function SchemaTab({ data }: { data: SchemaResponse }) {
  const [search, setSearch] = useState("");
  const [onlyLive, setOnlyLive] = useState(false);

  const dps = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data.dps ?? []).filter((dp) => {
      if (onlyLive && !dp.hasValue) return false;
      if (!term) return true;
      return [String(dp.id), dp.code, dp.name, dp.label ?? "", dp.kind]
        .join(" ")
        .toLowerCase()
        .includes(term);
    });
  }, [data.dps, search, onlyLive]);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const dp of data.dps ?? []) counts.set(dp.kind, (counts.get(dp.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.dps]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="filtrar por id, code ou nome"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant={onlyLive ? "secondary" : "outline"}
          className="h-8 text-xs"
          onClick={() => setOnlyLive((v) => !v)}
        >
          só com valor
        </Button>
      </div>

      <div className="flex flex-wrap gap-1">
        {kinds.map(([kind, n]) => (
          <Badge key={kind} variant="outline" className="font-mono text-[10px]">
            {KIND_LABEL[kind] ?? kind} × {n}
          </Badge>
        ))}
        <Badge variant="outline" className="text-[10px]">
          schema {data.schemaSource === "product" ? "do produto" : "do aparelho"}
        </Badge>
      </div>

      {dps.length ? (
        <ul className="grid gap-2 sm:grid-cols-2">
          {dps.map((dp) => (
            <DpCard key={String(dp.id)} dp={dp} />
          ))}
        </ul>
      ) : (
        <p className="rounded-lg bg-secondary/40 px-3 py-2.5 text-xs text-muted-foreground">
          nenhum DP casa com o filtro.
        </p>
      )}
    </div>
  );
}

function AbilityTab({ data }: { data: AbilityResponse }) {
  const product = data.product ?? ({} as AbilityResponse["product"]);
  const shortcut = product.shortcut ?? {};
  return (
    <div className="space-y-4">
      <Block title="Produto">
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-1.5">
          <Kv k="productId" v={product.id || "—"} mono />
          <Separator className="bg-border/50" />
          <Kv k="categoria" v={product.category || "—"} mono />
          <Separator className="bg-border/50" />
          <Kv k="categoryCode" v={product.categoryCode || "—"} mono />
          <Separator className="bg-border/50" />
          <Kv
            k="capability"
            v={product.capability != null ? `${product.capability} (0b${(product.capability >>> 0).toString(2)})` : "—"}
            mono
          />
          <Separator className="bg-border/50" />
          <Kv
            k="attribute"
            v={product.attribute != null ? `${product.attribute} (0b${(product.attribute >>> 0).toString(2)})` : "—"}
            mono
          />
          <Separator className="bg-border/50" />
          <Kv k="mesh" v={product.meshCategory || "não"} />
        </div>
      </Block>

      <Block title="DPS por tipo">
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(data.dpsByKind ?? {}).map(([kind, n]) => (
            <Badge key={kind} variant="secondary" className="font-mono text-[10px]">
              {KIND_LABEL[kind] ?? kind} × {n}
            </Badge>
          ))}
          <Badge variant="outline" className="text-[10px]">
            {data.dpsWritable ?? 0} graváveis / {data.dpsReadOnly ?? 0} só leitura
          </Badge>
        </div>
      </Block>

      <Block title="Painel principal do app">
        {(data.primaryDps ?? []).length ? (
          <ul className="space-y-1">
            {(data.primaryDps ?? []).map((dp) => (
              <li
                key={dp.id}
                className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5 text-xs"
              >
                <span className="font-mono text-[11px] tabular-nums text-primary">
                  #{dp.id}
                </span>
                <span className="truncate">{dp.label || dp.code}</span>
                <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                  {KIND_LABEL[dp.kind] ?? dp.kind}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">
            o app não declara atalhos para este produto.
          </p>
        )}
        {data.switchDp != null && (
          <p className="font-mono text-[10px] text-muted-foreground">
            switchDp = {data.switchDp} · quickOpDps ={" "}
            {(shortcut.quickOpDps ?? []).join(", ") || "—"} · faultDps ={" "}
            {(shortcut.faultDps ?? []).join(", ") || "—"}
          </p>
        )}
      </Block>

      <Block title="Cenas dinâmicas">
        {(data.dynamicScenes ?? []).length ? (
          <div className="flex flex-wrap gap-1.5">
            {(data.dynamicScenes ?? []).map((scene) => (
              <Badge key={scene.name} variant="outline" className="text-[10px]">
                {scene.name}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">nenhuma cena gravada no aparelho.</p>
        )}
      </Block>

      <Block title="Extras do dispositivo">
        <div className="rounded-lg border border-border/60 bg-background/40 px-3 py-1.5">
          <Kv k="gwType" v={data.gwType || "—"} mono />
          <Separator className="bg-border/50" />
          <Kv k="accessType" v={data.accessType ?? "—"} mono />
          <Separator className="bg-border/50" />
          <Kv k="ui" v={data.ui || "—"} mono />
          <Separator className="bg-border/50" />
          <Kv k="uiType / fase" v={`${data.uiType || "—"} / ${data.uiPhase || "—"}`} mono />
          <Separator className="bg-border/50" />
          <Kv k="grupo" v={data.supportGroup ? "aceita" : "não aceita"} />
        </div>
        {Object.keys(data.senior ?? {}).length ? (
          <Json value={data.senior} rows={8} />
        ) : (
          <p className="text-[11px] text-muted-foreground">
            senior.ability.get respondeu vazio neste aparelho.
          </p>
        )}
      </Block>
    </div>
  );
}

function FirmwareTab({ data }: { data: FirmwareResponse }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-background/40 px-3 py-2.5">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
            versão atual
          </p>
          <p className="font-mono text-lg font-semibold tabular-nums text-primary">
            {data.current || "—"}
          </p>
        </div>
        <Badge variant={data.pending ? "destructive" : "secondary"}>
          {data.pending ? "atualização pendente" : "em dia"}
        </Badge>
      </div>

      <Block title="Módulos">
        <div className="overflow-hidden rounded-lg border border-border/60">
          <table className="w-full text-left text-xs">
            <thead className="bg-secondary/40 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-1.5 font-medium">módulo</th>
                <th className="px-3 py-1.5 font-medium">versão</th>
                <th className="px-3 py-1.5 font-medium">estado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {(data.modules ?? []).map((m) => (
                <tr key={`${m.type}-${m.typeDesc}`}>
                  <td className="px-3 py-1.5">
                    {m.typeDesc || `tipo ${m.type}`}
                    {m.hasKey ? (
                      <span className="ml-1.5 text-[10px] text-emerald-400/80">chave</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-1.5 font-mono tabular-nums">{m.currentVersion || "—"}</td>
                  <td className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    {m.upgradeStatus === 0 ? "ocioso" : `status ${m.upgradeStatus}`}
                  </td>
                </tr>
              ))}
              {!(data.modules ?? []).length && (
                <tr>
                  <td colSpan={3} className="px-3 py-2 text-muted-foreground">
                    o gateway não devolveu módulos.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Block>

      {(data.updates ?? []).length > 0 && (
        <Block title="Atualizações disponíveis">
          <Json value={data.updates} rows={8} />
        </Block>
      )}

      {(data.warnings ?? []).length > 0 && (
        <Block title="Avisos do produto">
          <Json value={data.warnings} rows={8} />
        </Block>
      )}

      {(data.lowPower ?? []).length > 0 && (
        <Block title="Conexão de baixo consumo">
          <Json value={data.lowPower} rows={6} />
        </Block>
      )}

      {!!data.errors && Object.keys(data.errors).length > 0 && (
        <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300">
          partes da consulta falharam: {Object.entries(data.errors).map(([k, v]) => `${k} (${v})`).join(" · ")}
        </p>
      )}
    </div>
  );
}

function RawTab({ data }: { data: RawResponse }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] text-muted-foreground">
        {data.count ?? Object.keys(data.dps ?? {}).length} DPS no estado, como o
        gateway devolveu — sem conversão.
      </p>
      {!!data.errors && Object.keys(data.errors).length > 0 && (
        <p className="rounded-lg bg-amber-400/10 px-3 py-2 text-[11px] text-amber-300">
          {Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join(" · ")}
        </p>
      )}
      <details className="group rounded-lg border border-border/60 bg-background/40">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium marker:hidden">
          <ChevronDown className="mr-1.5 inline size-3.5 transition-transform group-open:rotate-180" />
          estado dos DPS (s.m.dev.dp.get)
        </summary>
        <div className="px-3 pb-3">
          <Json value={data.dps} />
        </div>
      </details>
      <details className="group rounded-lg border border-border/60 bg-background/40">
        <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium marker:hidden">
          <ChevronDown className="mr-1.5 inline size-3.5 transition-transform group-open:rotate-180" />
          smartlife.m.device.get (sem a localKey)
        </summary>
        <div className="px-3 pb-3">
          <Json value={data.device} rows={30} />
        </div>
      </details>
    </div>
  );
}

export default function ExtDeviceInfoPanel({ id }: { id: string }) {
  const [auto, setAuto] = useState(false);
  const { schema, ability, firmware, raw } = usePanelQueries(id, auto ? 60_000 : 0);
  const [tab, setTab] = useState("schema");

  const busy =
    schema.isFetching || ability.isFetching || firmware.isFetching || raw.isFetching;

  function refresh() {
    void schema.refetch();
    void ability.refetch();
    void firmware.refetch();
    void raw.refetch();
  }

  if (!id) {
    return (
      <Card className="border-border/70 bg-card/60">
        <CardContent className="pt-6">
          <p className="text-xs text-muted-foreground">escolha um dispositivo</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-4 border-border/70 bg-card/60">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-1">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-secondary/40 text-cyan-300">
            <Cpu className="size-4" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {schema.data?.name || "Detalhes do dispositivo"}
            </p>
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {schema.data?.productId || id}
              {schema.data?.ip ? ` · ${schema.data.ip}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {schema.data?.isOnline !== undefined && (
            <Badge variant={schema.data.isOnline ? "default" : "secondary"}>
              {schema.data.isOnline ? "online" : "offline"}
            </Badge>
          )}
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="size-8"
            disabled={busy}
            onClick={refresh}
            title="reconsultar"
          >
            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-2">
        <Tabs value={tab} onValueChange={setTab} className="space-y-3">
          <TabsList className="w-full">
            <TabsTrigger value="schema" className="text-xs">
              <Waypoints className="mr-1.5 size-3.5" />
              Schema
              {schema.data?.dpsCount ? ` (${schema.data.dpsCount})` : ""}
            </TabsTrigger>
            <TabsTrigger value="ability" className="text-xs">
              <Layers className="mr-1.5 size-3.5" />
              Capacidades
            </TabsTrigger>
            <TabsTrigger value="firmware" className="text-xs">
              <RefreshCw className="mr-1.5 size-3.5" />
              Firmware
              {firmware.data?.pending ? " !" : ""}
            </TabsTrigger>
            <TabsTrigger value="raw" className="text-xs">
              <ChevronDown className="mr-1.5 size-3.5" />
              Estado bruto
            </TabsTrigger>
          </TabsList>

          <TabsContent value="schema" className="mt-0">
            <Problem query={schema}>
              {schema.data && <SchemaTab data={schema.data} />}
            </Problem>
          </TabsContent>

          <TabsContent value="ability" className="mt-0">
            <Problem query={ability}>
              {ability.data && <AbilityTab data={ability.data} />}
            </Problem>
          </TabsContent>

          <TabsContent value="firmware" className="mt-0">
            <Problem query={firmware}>
              {firmware.data && <FirmwareTab data={firmware.data} />}
            </Problem>
          </TabsContent>

          <TabsContent value="raw" className="mt-0">
            <Problem query={raw}>
              {raw.data && <RawTab data={raw.data} />}
            </Problem>
          </TabsContent>
        </Tabs>
      </CardContent>

      <CardFooter className="flex-row items-center gap-3 border-t border-border/50 px-6 py-2.5">
        <Label className="flex cursor-pointer items-center gap-2 text-[10px] text-muted-foreground">
          <Switch
            checked={auto}
            onCheckedChange={setAuto}
            className="scale-90"
            aria-label="atualizar sozinho a cada minuto"
          />
          auto {auto ? "ligado (60s)" : "desligado"}
        </Label>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground/60">
          {busy ? "consultando…" : `${id.slice(0, 10)}…`}
        </span>
      </CardFooter>
    </Card>
  );
}