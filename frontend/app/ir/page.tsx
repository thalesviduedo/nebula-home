"use client";

import { useCloudStatus } from "@/hooks/useCloud";
import CloudRequired from "@/components/CloudRequired";
import TvRemote from "@/components/TvRemote";

/**
 * IR & Controle: o blaster da conta manda os códigos aprendidos. Sem sessão
 * no navegador não existe caminho até o blaster — a página diz isso em vez
 * de mostrar botões mortos.
 */
export default function IrPage() {
  const { data: cloud } = useCloudStatus();
  const cloudUp = Boolean(cloud?.logged_in || cloud?.rtsp?.alive);

  return (
    <div className="mx-auto w-full max-w-[1540px] px-5 py-6">
      {cloudUp ? <TvRemote /> : <CloudRequired />}
    </div>
  );
}
