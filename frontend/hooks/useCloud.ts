"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { api, type CamSources, type CamStatus, type CloudStatus } from "@/lib/api";

/** Fontes de vídeo publicadas pelo tuya-ipc-terminal (RTSP local). */
export function useCamSources(pollMs = 6000) {
  return useQuery<CamSources>({
    queryKey: ["cam-sources"],
    queryFn: () => api.camSources(),
    refetchInterval: pollMs,
    placeholderData: (prev) => prev,
  });
}

/** Telemetria viva do stream enquanto ele está aberto. */
export function useCamStreamStatus(path: string, active: boolean, pollMs = 2500) {
  return useQuery<CamStatus>({
    queryKey: ["cam-status", path, active],
    queryFn: () => api.camStatus(path),
    enabled: active,
    refetchInterval: active ? pollMs : false,
    placeholderData: (prev) => prev,
  });
}

/** Sondagem sob demanda: abre o RTSP, lê 1 quadro e fecha. */
export function useCamProbe() {
  return useMutation({ mutationFn: (path: string) => api.camStatus(path, true) });
}

/**
 * Estado da conta. Só faz sentido porque o backend lê os cookies do bundle
 * que vai no header — sem bundle no navegador, `logged_in` é false.
 */
export function useCloudStatus(pollMs = 5000) {
  return useQuery<CloudStatus>({
    queryKey: ["cloud"],
    queryFn: () => api.cloudStatus(),
    refetchInterval: pollMs,
    placeholderData: (prev) => prev,
  });
}
