"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Power, PowerOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { api, type Device } from "@/lib/api";
import { useNotify } from "@/lib/query";

/**
 * Comando em massa nos aparelhos da visão atual — o que o app original não
 * tem: um toque liga/desliga tudo que está visível no filtro (respeita a
 * aba: em "Tomadas" só as tomadas). Cada aparelho recebe seu próprio
 * comando (LAN ou nuvem, o backend escolhe); o resultado é agregado.
 *
 * Renderiza só os botões: o contêiner é a ribbon do dashboard.
 */
export default function BulkBar({ devices }: { devices: Device[] }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const targets = devices.filter(
    (d) => (d.kind === "bulb" || d.kind === "plug") && (d.local || d.remote),
  );
  const [busy, setBusy] = useState<null | "on" | "off">(null);
  const [open, setOpen] = useState(false);
  if (targets.length < 2) return null;

  async function run(action: "on" | "off") {
    setBusy(action);
    const res = await Promise.allSettled(
      targets.map((d) => api.control(d.id, action, {})),
    );
    const ok = res.filter((r) => r.status === "fulfilled").length;
    setBusy(null);
    setOpen(false);
    await qc.invalidateQueries({ queryKey: ["devices"] });
    notify(
      action === "off"
        ? `Desligados ${ok}/${targets.length}`
        : `Ligados ${ok}/${targets.length}`,
      ok === targets.length ? "ok" : "err",
    );
  }

  return (
    <>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => run("on")}
        className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[12px] font-medium text-on-primary shadow-[0_0_20px_rgba(76,215,246,0.35)] transition-all hover:bg-primary-fixed-dim active:scale-95 disabled:opacity-60"
      >
        {busy === "on" ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Power className="size-4" />
        )}
        Ligar tudo
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            disabled={busy !== null}
            className="flex items-center gap-2 rounded-xl bg-error px-4 py-2 text-[12px] font-medium text-on-error shadow-[0_0_18px_rgba(255,180,171,0.25)] transition-all hover:brightness-110 active:scale-95 disabled:opacity-60"
          >
            {busy === "off" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PowerOff className="size-4" />
            )}
            Desligar tudo
          </button>
        </DialogTrigger>
        <DialogContent className="border-outline-variant/40 bg-surface-container-low">
          <DialogHeader>
            <DialogTitle>Desligar {targets.length} aparelhos?</DialogTitle>
            <DialogDescription>
              Envia &quot;off&quot; para cada um dos {targets.length} aparelhos
              desta visão, pela LAN ou pela nuvem.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-xl bg-surface-container-high px-4 py-2 text-[12px] font-medium text-on-surface transition-colors hover:bg-surface-bright"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={() => run("off")}
              className="rounded-xl bg-error px-4 py-2 text-[12px] font-medium text-on-error transition-all hover:brightness-110"
            >
              Desligar tudo
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
