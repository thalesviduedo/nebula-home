"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  House, KeyRound, LayoutGrid, Lightbulb, Plug, Radio, Video,
} from "lucide-react";
import Header from "@/components/Header";
import Sidebar from "@/components/Sidebar";
import { useScan } from "@/hooks/useDevices";
import { useNotify } from "@/lib/query";
import { ShellContext, type ShellCtx } from "@/lib/shell";

const MOBILE_NAV = [
  { href: "/", label: "Todos", icon: LayoutGrid },
  { href: "/iluminacao", label: "Luz", icon: Lightbulb },
  { href: "/tomadas", label: "Tomadas", icon: Plug },
  { href: "/ir", label: "IR", icon: Radio },
  { href: "/cameras", label: "Câmeras", icon: Video },
  { href: "/inventario", label: "Chaves", icon: KeyRound },
  { href: "/casa", label: "Casa", icon: House },
] as const;

/**
 * Shell da aplicação: topbar fixa + menu lateral (Zonas & Módulos) + área de
 * conteúdo. O estado global (auto-refresh, varredura, sync) vive aqui e é
 * consumido por topbar e páginas via `useShell`.
 */
export default function AppShell({ children }: { children: ReactNode }) {
  const notify = useNotify();
  const qc = useQueryClient();
  const [auto, setAuto] = useState(false);
  const scan = useScan();
  const path = usePathname();

  const doScan = useCallback(() => {
    notify("varredura da rede iniciada (~25s)…");
    scan
      .mutateAsync((st) => {
        if (!st.running) notify(`achados: ${st.found.length}`, "");
      })
      .then((s) => {
        notify(s.changes.join(" · ") || `scan concluído · ${s.found.length} na rede`, "ok");
      })
      .catch((e) => notify(`scan falhou: ${e}`, "err"));
  }, [notify, scan]);

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["devices"] });
    qc.invalidateQueries({ queryKey: ["cloud"] });
    qc.invalidateQueries({ queryKey: ["cam-sources"] });
    qc.invalidateQueries({ queryKey: ["ir-buttons"] });
  }, [qc]);

  const ctx = useMemo<ShellCtx>(
    () => ({
      auto,
      toggleAuto: () => setAuto((a) => !a),
      doScan,
      scanning: scan.isPending,
      refreshAll,
    }),
    [auto, doScan, scan.isPending, refreshAll],
  );

  return (
    <ShellContext.Provider value={ctx}>
      <div className="min-h-dvh">
        <Header />
        <Sidebar />
        <div className="lg:pl-64">
          {/* navegação compacta para telas sem a coluna lateral */}
          <nav className="nebu-nav fixed inset-x-0 top-16 z-40 flex gap-1 overflow-x-auto border-b border-white/[0.06] bg-surface/85 px-3 py-1.5 backdrop-blur-xl lg:hidden">
            {MOBILE_NAV.map((item) => {
              const active =
                item.href === "/" ? path === "/" : path.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                    active
                      ? "bg-primary/15 text-primary"
                      : "text-on-surface-variant hover:bg-surface-container-high"
                  }`}
                >
                  <Icon className="size-3.5" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <main className="min-h-screen bg-surface pt-[6.25rem] text-on-surface lg:pt-16">
            {children}
          </main>
        </div>
      </div>
    </ShellContext.Provider>
  );
}
