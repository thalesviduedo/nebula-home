"use client";

import DeviceGridPage from "@/components/views/DeviceGridPage";

export default function IluminacaoPage() {
  return (
    <DeviceGridPage
      kind="bulb"
      title="Iluminação"
      description="Lâmpadas RGBW: brilho, temperatura e cor por LAN ou nuvem"
      emptyLabel="nenhuma lâmpada na lista — conecte a conta ou rode o LAN Discovery"
    />
  );
}
