"use client";

import { useQuery } from "@tanstack/react-query";
import { api, type AppConfig } from "@/lib/api";

/** Configuração do backend: região, país, blaster IR, câmera e fatos do P2P.
 *  É o que impede o front de carregar constantes hardcoded. */
export function useConfig() {
  return useQuery<AppConfig>({
    queryKey: ["config"],
    queryFn: () => api.config(),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
}
