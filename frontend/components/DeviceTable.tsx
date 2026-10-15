"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { Dices, KeyRound, Loader2, RefreshCw, Search, X } from "lucide-react";
import type { Device } from "@/lib/api";
import { deviceStatus } from "@/lib/device-status";
import { KIND_LABEL } from "./DeviceCard";
import { getBundle, serverBundle, subscribe } from "@/lib/bundle";
import { useDeviceStatus } from "@/hooks/useDevices";
import { useNotify } from "@/lib/query";
import { Input } from "@/components/ui/input";

/**
 * Table v9 (9.x) trocou `useReactTable` por `useTable` e os row models
 * passaram a ser slots em `tableFeatures`. `features` e `columns` ficam em
 * escopo de módulo: recriá-los a cada render invalida os row models.
 */
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

const helper = createColumnHelper<typeof features, Device>();

const BADGE = "rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap";

/** Mesmos tons do device-status, em classes do design. */
function stateClass(label: string): string {
  if (label === "ligado" || label === "online") return "bg-primary/20 text-primary";
  if (label === "desligado") return "bg-surface-container-highest text-on-surface-variant";
  if (label === "offline") return "bg-error/15 text-error";
  if (label === "nuvem") return "bg-tertiary-container/15 text-tertiary";
  return "bg-surface-container-high text-on-surface-variant";
}

const columns = helper.columns([
  helper.accessor("name", {
    header: "Dispositivo",
    cell: (i) => {
      const d = i.row.original;
      // device achado no scan entra na lista sem chave: o motivo e a versão
      // vêm no note, senão a linha parece um device de nuvem qualquer
      const achadoNaRede = d.ip && !d.local;
      return (
        <div className="flex min-w-0 items-center gap-3">
          <div
            className={`grid size-8 shrink-0 place-items-center rounded-lg bg-surface-container-high ${
              d.kind === "bulb"
                ? "text-primary"
                : d.kind === "plug"
                  ? "text-mint"
                  : d.kind === "ir"
                    ? "text-tertiary"
                    : "text-primary"
            }`}
          >
            <span className="text-[11px] font-bold uppercase">{d.kind.slice(0, 2)}</span>
          </div>
          <div className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-on-surface">
              {i.getValue()}
            </span>
            {achadoNaRede && d.note && (
              <span className="block text-[10px] font-normal text-tertiary/80">{d.note}</span>
            )}
          </div>
        </div>
      );
    },
    sortFn: "alphanumeric",
  }),
  helper.accessor("kind", {
    header: "Tipo",
    cell: (i) => (
      <span className={`${BADGE} bg-surface-container-high text-on-surface-variant`}>
        {KIND_LABEL[i.getValue()] ?? i.getValue()}
      </span>
    ),
  }),
  helper.accessor("ip", {
    header: "Rede / IP",
    cell: (i) => {
      const d = i.row.original;
      if (d.ip) {
        return (
          <div className="flex flex-col">
            <span className="font-mono text-[11px] text-on-surface">{d.ip}</span>
            <span className="flex items-center gap-1 text-[10px] text-mint">
              <span className="size-1 rounded-full bg-mint" />
              {d.local ? "LAN Direct" : "IP do scan"}
            </span>
          </div>
        );
      }
      return (
        <span className="font-mono text-[11px] text-outline">
          {d.remote ? "fora da LAN" : "—"}
        </span>
      );
    },
  }),
  helper.accessor("local", {
    header: "Controle",
    // `local` = chave + IP na LAN. `remote` = dá para comandar pelo gateway
    // móvel mesmo fora de casa, exatamente como o app. Sem nenhum dos dois,
    // o device foi visto na rede mas não tem chave para comandar.
    cell: (i) => {
      const d = i.row.original;
      if (i.getValue())
        return <span className={`${BADGE} bg-secondary-container/20 text-mint`}>LAN</span>;
      if (d.remote)
        return <span className={`${BADGE} bg-primary-container/20 text-primary`}>nuvem</span>;
      if (d.kind === "cam")
        return <span className={`${BADGE} bg-surface-container-high text-on-surface-variant`}>vídeo P2P</span>;
      return (
        <span className={`${BADGE} bg-surface-container-high text-on-surface-variant`}>
          {d.ip ? "sem controle" : "sem chave"}
        </span>
      );
    },
  }),
  helper.accessor("ok", {
    header: "Estado",
    // Rótulo e variante vêm de lib/device-status — a MESMA função do card.
    cell: (i) => {
      const st = deviceStatus(i.row.original);
      return <span className={`${BADGE} ${stateClass(st.label)}`}>{st.label}</span>;
    },
  }),
  helper.accessor("id", {
    header: "ID do Hardware",
    cell: (i) => (
      <span className="font-mono text-[11px] text-on-surface-variant">
        {i.getValue().slice(0, 14)}…
      </span>
    ),
  }),
  helper.accessor((r) => Object.keys(r.dps).length, {
    id: "dps",
    header: "DPS",
    sortFn: "basic",
    cell: (i) => {
      const d = i.row.original;
      const keys = Object.keys(d.dps);
      if (keys.length === 0) return <span className="font-mono text-[11px] text-outline">0</span>;
      return (
        <div className="flex items-center gap-1">
          {keys.slice(0, 3).map((k) => (
            <span
              key={k}
              className="rounded bg-surface-container-low px-1.5 py-0.5 font-mono text-[10px] text-on-surface"
            >
              {k}
            </span>
          ))}
          {keys.length > 3 && (
            <span className="text-[10px] text-outline">+{keys.length - 3}</span>
          )}
        </div>
      );
    },
  }),
]);

const ARROW = { asc: " ↑", desc: " ↓" } as const;

const CHIPS = [
  { id: "all", label: "Todos", match: () => true },
  { id: "light", label: "Iluminação", match: (d: Device) => d.kind === "bulb" },
  { id: "plug", label: "Tomadas", match: (d: Device) => d.kind === "plug" },
  { id: "ir", label: "IR & Remoto", match: (d: Device) => d.kind === "ir" },
  { id: "camera", label: "Câmeras", match: (d: Device) => d.kind === "cam" },
  { id: "offline", label: "Offline", match: (d: Device) => !d.ok },
] as const;

export default function DeviceTable({ data }: { data: Device[] }) {
  const notify = useNotify();
  const [q, setQ] = useState("");
  const [chip, setChip] = useState<(typeof CHIPS)[number]["id"]>("all");
  const refreshOne = useDeviceStatus();

  // presença de chave no cofre (NUNCA o valor: a localKey é segredo)
  const bundle = useSyncExternalStore(subscribe, getBundle, serverBundle);
  const withKey = (id: string) => Boolean(bundle.keys[id]?.localKey);

  const chipMatch = CHIPS.find((c) => c.id === chip)!.match;

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    return data.filter((d) => {
      if (!chipMatch(d)) return false;
      if (!t) return true;
      return [d.name, d.kind, d.ip ?? "", d.id, d.category ?? ""].some((v) =>
        String(v).toLowerCase().includes(t),
      );
    });
  }, [data, q, chipMatch]);

  const table = useTable({ features, columns, data: rows });

  return (
    <div className="flex flex-col overflow-hidden rounded-xl bg-surface-container/60 shadow-xl backdrop-blur-md">
      {/* filtros + busca */}
      <div className="flex flex-col justify-between gap-3 px-4 pt-4 md:flex-row md:items-center">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {CHIPS.map((c) => {
            const count = data.filter(c.match).length;
            const active = chip === c.id;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setChip(c.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] transition-all ${
                  active
                    ? "bg-primary font-medium text-on-primary shadow-sm"
                    : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                }`}
              >
                {c.label}
                <span
                  className={`rounded-full px-1.5 font-mono text-[10px] ${
                    active ? "bg-on-primary/20 text-on-primary" : "bg-surface-container-high"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative min-w-[260px] lg:min-w-[320px]">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-on-surface-variant" />
          <Input
            placeholder="Filtrar por nome, DPS, ID ou IP…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-9 border-0 bg-surface-container pl-9 pr-16 text-xs shadow-sm focus-visible:bg-surface-container-high focus-visible:ring-0"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 font-mono text-[10px] text-outline">
            {rows.length} de {data.length}
          </span>
          {q && (
            <button
              type="button"
              onClick={() => setQ("")}
              className="absolute right-14 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface"
              aria-label="limpar filtro"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* cabeçalho da tabela */}
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-semibold text-on-surface">
            Inventário de Módulos &amp; DPS
          </span>
          <span className="text-[11px] text-outline">clique nas colunas para ordenar</span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-on-surface-variant">
          <span className="size-2 rounded-full bg-mint" />
          {data.length} sincronizados localmente
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-surface-container-high/40 text-[10px] uppercase tracking-wider text-on-surface-variant">
              {table.getHeaderGroups().map((hg) =>
                hg.headers.map((h) => {
                  const col = h.column;
                  const toggle = col.getToggleSortingHandler?.();
                  const dir = col.getIsSorted();
                  return (
                    <th
                      key={`${hg.id}-${h.id}`}
                      onClick={toggle ? (e) => toggle(e) : undefined}
                      className={`select-none whitespace-nowrap px-3 py-3 font-normal transition-colors ${
                        dir ? "text-primary" : "hover:text-on-surface"
                      } ${col.getCanSort() ? "cursor-pointer" : ""}`}
                    >
                      {h.isPlaceholder ? null : <table.FlexRender header={h} />}
                      {dir ? ARROW[dir] : ""}
                    </th>
                  );
                }),
              )}
              <th className="select-none whitespace-nowrap px-3 py-3 text-right font-normal">
                Chave / Ações
              </th>
            </tr>
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className="border-t border-white/[0.04] transition-colors hover:bg-surface-container-high/30"
              >
                {row.getAllCells().map((cell) => (
                  <td key={cell.id} className="whitespace-nowrap px-3 py-3">
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
                <td className="px-3 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {withKey(row.original.id) ? (
                      <span
                        title="chave local no cofre do navegador (nunca exibida)"
                        className="flex items-center gap-1 rounded-lg bg-surface-container px-2 py-1.5 font-mono text-[10px] text-primary"
                      >
                        <KeyRound className="size-3.5" />
                        no cofre
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 rounded-lg bg-surface-container px-2 py-1.5 font-mono text-[10px] text-outline">
                        <Dices className="size-3.5" />
                        sem chave
                      </span>
                    )}
                    <button
                      type="button"
                      title="Sincronizar estado deste aparelho"
                      disabled={refreshOne.isPending && refreshOne.variables === row.original.id}
                      onClick={() =>
                        refreshOne.mutate(row.original.id, {
                          onSuccess: () => notify(`${row.original.name}: estado sincronizado`, "ok"),
                          onError: (e) => notify(`falha: ${e}`, "err"),
                        })
                      }
                      className="rounded-lg bg-surface-container p-1.5 text-on-surface-variant transition-all hover:bg-surface-bright hover:text-primary"
                    >
                      {refreshOne.isPending && refreshOne.variables === row.original.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-8 text-center text-xs text-muted-foreground">
                  nada encontrado
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* rodapé técnico */}
      <div className="flex flex-col items-center justify-between gap-2 bg-surface-container-low/60 px-4 py-3 text-[11px] text-on-surface-variant sm:flex-row">
        <div className="flex items-center gap-3">
          <span>
            Total: <strong className="text-on-surface">{data.length} nós</strong>
          </span>
          <span className="text-outline-variant">•</span>
          <span>
            Criptografia: <strong className="font-mono text-primary">AES-128</strong>
          </span>
          <span className="text-outline-variant">•</span>
          <span>
            Chaves no cofre:{" "}
            <strong className="font-mono text-mint">
              {data.filter((d) => withKey(d.id)).length}
            </strong>
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono">
          <span className="text-outline">Cofre Local:</span>
          <span className="flex items-center gap-1 text-mint">
            <span className="size-1.5 rounded-full bg-mint" />
            no navegador
          </span>
        </div>
      </div>
    </div>
  );
}
