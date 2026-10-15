"use client";

import { Braces, Lock, Router } from "lucide-react";
import { useDevices } from "@/hooks/useDevices";
import { useShell } from "@/lib/shell";
import CloudCard from "@/components/CloudCard";
import DeviceTable from "@/components/DeviceTable";

/**
 * Inventário & Chaves Tuya — o console do cofre: sessão, métricas do que está
 * guardado no navegador, backup e a tabela completa de módulos com DPS.
 */
export default function InventarioPage() {
  const shell = useShell();
  const { devices = [] } = useDevices(shell.auto);

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-6 px-5 py-6">
      <CloudCard />
      <DeviceTable data={devices} />

      {/* bento: por que este painel é seguro e local — fatos do projeto */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2 rounded-xl bg-surface-container/60 p-4 shadow-md backdrop-blur-md">
          <div className="grid size-8 place-items-center rounded-lg bg-primary-container/20 text-primary">
            <Lock className="size-5" />
          </div>
          <span className="text-[15px] font-semibold text-on-surface">Sem Vazamento Externo</span>
          <p className="text-[12px] leading-relaxed text-on-surface-variant">
            As localKeys nunca chegam ao backend: viajam em cada requisição no
            header <code className="text-primary">X-Nebula-Bundle</code> e o
            servidor monta a resposta, devolve e esquece. Não há estado em
            disco, não há banco, não há cópia.
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded-xl bg-surface-container/60 p-4 shadow-md backdrop-blur-md">
          <div className="grid size-8 place-items-center rounded-lg bg-secondary-container/20 text-secondary">
            <Router className="size-5" />
          </div>
          <span className="text-[15px] font-semibold text-on-surface">Independência da Nuvem</span>
          <p className="text-[12px] leading-relaxed text-on-surface-variant">
            Com IP na LAN e chave no cofre, o comando sai direto pelo protocolo
            Tuya 3.3/3.5 em TCP 6668 — sem passar pela internet. O scan da rede
            (UDP) descobre quando o hardware troca de IP no DHCP.
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded-xl bg-surface-container/60 p-4 shadow-md backdrop-blur-md">
          <div className="grid size-8 place-items-center rounded-lg bg-tertiary-container/20 text-tertiary">
            <Braces className="size-5" />
          </div>
          <span className="text-[15px] font-semibold text-on-surface">Esquema Dinâmico de DPS</span>
          <p className="text-[12px] leading-relaxed text-on-surface-variant">
            Cada aparelho tem seu mapa de Data Points — brilho no 22,
            temperatura no 23, cor no 24, timer no 9 — e o painel traduz os
            índices brutos para os controles. A coluna DPS mostra o que cada
            aparelho reportou de verdade.
          </p>
        </div>
      </div>
    </div>
  );
}
