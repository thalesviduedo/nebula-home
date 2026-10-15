"use client";

import { useState } from "react";
import { useDevices } from "@/hooks/useDevices";
import { useShell } from "@/lib/shell";
import ExtDeviceInfoPanel from "@/components/ExtDeviceInfoPanel";
import ExtEnergyPanel from "@/components/ExtEnergyPanel";
import ExtIpcPanel from "@/components/ExtIpcPanel";
import ExtMessagesPanel from "@/components/ExtMessagesPanel";
import ExtRoomsPanel from "@/components/ExtRoomsPanel";
import ExtScenesPanel from "@/components/ExtScenesPanel";

/** Casa & Automação: cômodos, cenas, energia, avisos e detalhe do aparelho. */
export default function CasaPage() {
  const shell = useShell();
  const { devices = [] } = useDevices(shell.auto);
  const [extDevice, setExtDevice] = useState("");
  const extId =
    extDevice || devices.find((d) => d.kind === "bulb" || d.kind === "plug")?.id || "";
  const cams = devices.filter((d) => d.kind === "cam");

  return (
    <div className="mx-auto flex w-full max-w-[1540px] flex-col gap-6 px-5 py-6">
      <ExtRoomsPanel />
      <ExtScenesPanel />
      <ExtEnergyPanel />
      <ExtMessagesPanel />

      <div className="flex flex-col gap-3 rounded-xl bg-surface-container-low p-5 shadow-xl backdrop-blur-md">
        <div>
          <h2 className="text-[15px] font-semibold text-on-surface">Detalhar aparelho</h2>
          <p className="mt-0.5 text-[11px] text-on-surface-variant">
            leitura estendida do gateway móvel para um device específico
          </p>
        </div>
        <select
          value={extId}
          onChange={(e) => setExtDevice(e.target.value)}
          className="w-full rounded-xl border-0 bg-surface-container-high px-3.5 py-2.5 text-sm text-on-surface outline-none transition-colors focus:bg-surface-bright"
        >
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} · {d.id.slice(0, 8)}
            </option>
          ))}
        </select>
        {extId && <ExtDeviceInfoPanel id={extId} />}
      </div>

      <ExtIpcPanel deviceId={cams[0]?.id} />
    </div>
  );
}
