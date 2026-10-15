"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  House, KeyRound, LayoutGrid, Lightbulb, Plug, Radio, Video,
} from "lucide-react";
import { useConfig } from "@/hooks/useConfig";
import { useCloudStatus } from "@/hooks/useCloud";

/** Zonas & Módulos — o menu lateral do design, com os módulos reais do app. */
const NAV = [
  { href: "/", label: "Todos", icon: LayoutGrid },
  { href: "/iluminacao", label: "Iluminação", icon: Lightbulb },
  { href: "/tomadas", label: "Tomadas", icon: Plug },
  { href: "/ir", label: "IR & Controle", icon: Radio },
  { href: "/cameras", label: "Câmeras", icon: Video },
  { href: "/inventario", label: "Inventário & Chaves Tuya", icon: KeyRound },
  { href: "/casa", label: "Casa & Automação", icon: House },
] as const;

export default function Sidebar() {
  const path = usePathname();
  const { data: cfg } = useConfig();
  const { data: cloud } = useCloudStatus(15_000);

  const blaster = cfg?.ir_blaster;
  const session = cloud?.sessions?.[0];

  return (
    <aside className="fixed bottom-0 left-0 top-16 z-40 hidden w-64 flex-col justify-between bg-surface-container-lowest/80 py-4 shadow-[1px_0_12px_rgba(0,0,0,0.25)] backdrop-blur-xl lg:flex">
      <div className="nebu-nav flex flex-col gap-4 overflow-y-auto px-2">
        <div className="px-2 py-1">
          <span className="text-[11px] uppercase tracking-wider text-outline">
            Zonas &amp; Módulos
          </span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active =
              item.href === "/" ? path === "/" : path.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-2.5 rounded-xl px-4 py-2.5 text-[13px] transition-all ${
                  active
                    ? "bg-primary-container font-semibold text-on-primary shadow-[0_0_12px_rgba(76,215,246,0.2)]"
                    : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                }`}
              >
                <Icon className="size-5 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>

      {/* Gateway Core: o que o backend sabe da conta/local, sem inventar */}
      <div className="px-4 py-2">
        <div className="flex flex-col gap-1 rounded-xl bg-surface-container-low p-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-on-surface-variant">
              {blaster ? "IR Blaster" : "Gateway Core"}
            </span>
            <span
              className={`size-1.5 rounded-full ${
                cloud?.logged_in || cloud?.rtsp?.alive
                  ? "bg-mint"
                  : "bg-outline"
              }`}
            />
          </div>
          <span className="font-mono text-[11px] text-primary">
            {blaster?.ip ?? session?.host ?? "sem sessão"}
          </span>
          <span className="text-[11px] text-outline">
            {session?.region
              ? `Tuya ${session.region}`
              : cloud?.logged_in
                ? "sessão ativa"
                : "Local Broker"}
          </span>
        </div>
      </div>
    </aside>
  );
}
