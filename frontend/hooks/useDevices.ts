"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE, api, type DeviceList } from "../lib/api";
import { bundleHeader, rememberLan } from "../lib/bundle";

export interface ScanState {
  running: boolean;
  finished_at: number;
  found: { ip: string; id?: string; version?: string }[];
  changes: string[];
  /** ip/versão por device — o front guarda isso no bundle, não o backend */
  lan?: Record<string, { ip: string; ver?: string }>;
}

/**
 * `/api/devices?fast=1` devolve o estado em cache do backend em ~4 ms;
 * a versão autoritativa consulta cada device na LAN e leva ~45 s.
 *
 * Por isso o dashboard consome as duas: mostra o instantâneo na hora e
 * troca pelo resultado completo quando ele chega. Sem isso a tela ficaria
 * 45 s em esqueleto a cada refresh.
 */
export function useDevices(auto = false, refetchMs = 30_000) {
  const fast = useFastDevices();
  const full = useQuery<DeviceList>({
    queryKey: ["devices", "full"],
    queryFn: () => api.devices(false),
    refetchInterval: auto ? refetchMs : false,
    placeholderData: (prev) => prev,
  });

  return {
    ...full,
    devices: full.data?.devices ?? fast.data?.devices,
    source: full.data?.source ?? fast.data?.source,
    isPending: full.isPending && fast.isPending,
    isFetching: fast.isFetching || full.isFetching,
    // enquanto o resultado completo não chega, dizemos que é o instantâneo
    isStale: !full.data && Boolean(fast.data),
  };
}

/** Versão rápida (sem blocking I/O) para dar retorno imediato no refresh. */
export function useFastDevices() {
  return useQuery<DeviceList>({
    queryKey: ["devices", "fast"],
    queryFn: () => api.devices(true),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  });
}

export function useScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (onProgress?: (s: ScanState) => void) => {
      await fetch(`${API_BASE}/api/scan?go=1`, { headers: bundleHeader() });
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = (await (
          await fetch(`${API_BASE}/api/scan`, { headers: bundleHeader() })
        ).json()) as ScanState;
        onProgress?.(s);
        if (!s.running) {
          // o IP fica guardado no navegador, não no servidor
          if (s.lan) rememberLan(s.lan);
          await qc.invalidateQueries({ queryKey: ["devices"] });
          return s;
        }
      }
      throw new Error("scan não terminou a tempo");
    },
  });
}

export function useControl() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: {
      id: string;
      action: string;
      params?: Record<string, string | number>;
    }) => api.control(v.id, v.action, v.params ?? {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });
}

export function useDeviceStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.status(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["devices"] }),
  });
}

export function useIrButtons() {
  return useQuery({
    queryKey: ["ir-buttons"],
    queryFn: () => api.irButtons(),
    staleTime: 60_000,
  });
}

export function useIr() {
  return useMutation({ mutationFn: (key: string) => api.ir(key) });
}