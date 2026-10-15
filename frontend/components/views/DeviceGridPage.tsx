"use client";

import { useDevices } from "@/hooks/useDevices";
import { useShell } from "@/lib/shell";
import BulkBar from "@/components/BulkBar";
import DeviceCard from "@/components/DeviceCard";
import type { Kind } from "@/lib/api";

/**
 * Grade filtrada por tipo (Iluminação / Tomadas), com o comando em massa
 * restrito ao que está visível — mesma regra do dashboard.
 */
export default function DeviceGridPage({
  kind, title, description, emptyLabel,
}: {
  kind: Kind;
  title: string;
  description: string;
  emptyLabel: string;
}) {
  const shell = useShell();
  const { devices = [], isPending } = useDevices(shell.auto);
  const list = devices.filter((d) => d.kind === kind);
  const online = list.filter((d) => d.ok).length;

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-6 px-5 py-6">
      <div className="flex flex-col justify-between gap-4 rounded-xl bg-surface-container-low p-5 shadow-xl backdrop-blur-md md:flex-row md:items-center">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-on-surface">
            {title}
          </h1>
          <p className="mt-1 text-[11px] text-on-surface-variant">
            {description} · {online} online de {list.length}
          </p>
        </div>
        <BulkBar devices={list} />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {isPending && list.length === 0
          ? Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel h-56" />)
          : list.map((d) => <DeviceCard key={d.id} d={d} />)}
      </div>

      {list.length === 0 && !isPending && (
        <p className="py-10 text-center text-sm text-muted-foreground">{emptyLabel}</p>
      )}
    </div>
  );
}
