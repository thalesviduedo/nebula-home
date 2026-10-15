"use client";

import DeviceGridPage from "@/components/views/DeviceGridPage";

export default function TomadasPage() {
  return (
    <DeviceGridPage
      kind="plug"
      title="Tomadas"
      description="Tomadas inteligentes: liga/desliga, timer e medição de energia"
      emptyLabel="nenhuma tomada na lista — conecte a conta ou rode o LAN Discovery"
    />
  );
}
