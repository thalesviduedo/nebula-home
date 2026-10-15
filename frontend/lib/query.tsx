"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { enforceNoBrowserPersistence } from "./no-persistence";
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ToastKind = "ok" | "err" | "";
export interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
}

const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useNotify = () => useContext(ToastCtx);

/**
 * Um client por render no servidor, um so no navegador (cache preservado
 * entre renders). Esse e o padrao recomendado pela guia do Next 16 para
 * TanStack Query.
 */
let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  if (typeof window === "undefined") return new QueryClient();
  browserQueryClient ??= new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 2_000 },
    },
  });
  return browserQueryClient;
}

function Toasts({ list }: { list: Toast[] }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
      {list.map((t) => (
        <div
          key={t.id}
          className={`max-w-xs rounded-xl border border-white/[0.08] bg-surface-container-high/95 px-4 py-2.5 text-sm text-on-surface shadow-2xl backdrop-blur ${
            t.kind === "ok"
              ? "border-l-4 border-l-mint"
              : t.kind === "err"
                ? "border-l-4 border-l-error"
                : "border-l-4 border-l-primary"
          }`}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  // roda antes de qualquer fetch: nada pode sobrar de uma sessão anterior
  enforceNoBrowserPersistence();

  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const notify = useCallback((msg: string, kind: ToastKind = "") => {
    const id = ++idRef.current;
    setToasts((t) => [...t.slice(-4), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <QueryClientProvider client={getQueryClient()}>
      {/* um provider só para a app inteira: Header, tabela e cards usam Tooltip */}
      <TooltipProvider delayDuration={200}>
        <ToastCtx.Provider value={notify}>
          {children}
          <Toasts list={toasts} />
        </ToastCtx.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}