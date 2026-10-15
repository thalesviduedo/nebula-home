"use client";

/**
 * Estado compartilhado do shell (AppShell): auto-refresh, varredura da LAN e
 * refresh global. Fica num contexto porque o topbar e as páginas usam os
 * mesmos controles — antes tudo vivia só na página única.
 */

import { createContext, useContext } from "react";

export interface ShellCtx {
  /** auto-refresh de 30s na lista de devices */
  auto: boolean;
  toggleAuto: () => void;
  /** varredura Tuya da LAN (manual, ~25s) com os toasts já embutidos */
  doScan: () => void;
  scanning: boolean;
  /** invalida devices/cloud/câmera/IR de uma vez */
  refreshAll: () => void;
}

export const ShellContext = createContext<ShellCtx>({
  auto: false,
  toggleAuto: () => {},
  doScan: () => {},
  scanning: false,
  refreshAll: () => {},
});

export const useShell = () => useContext(ShellContext);
