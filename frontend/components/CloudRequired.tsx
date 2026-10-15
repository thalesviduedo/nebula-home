"use client";

import { KeyRound } from "lucide-react";

/**
 * Placeholder no lugar dos controles de nuvem quando ainda não há sessão.
 * Sem cookie no bundle não há como abrir WebRTC nem enviar IR, então mostrar
 * os botões seria mentir sobre o que funciona.
 */
export default function CloudRequired() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-outline-variant/60 bg-surface-container-low/60 p-10 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-surface-container-high text-on-surface-variant">
        <KeyRound className="size-5" />
      </div>
      <h2 className="text-[15px] font-semibold text-on-surface">
        Controle de TV e câmera precisam da conta
      </h2>
      <p className="max-w-md text-[12px] leading-relaxed text-on-surface-variant">
        Conecte a conta Tuya em{" "}
        <span className="text-on-surface">Inventário &amp; Chaves Tuya</span>. A
        câmera não tem porta na LAN: o vídeo vem do relay de nuvem, e o IR é
        disparado pelo blaster da sua conta.
      </p>
      <p className="max-w-md text-[11px] text-outline">
        nada é controlado aqui até você logar — o backend não guarda sessão
        nenhuma, o cookie fica no seu navegador
      </p>
    </div>
  );
}
