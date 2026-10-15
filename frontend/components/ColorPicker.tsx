"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Palette } from "lucide-react";
import { HexColorInput, HexColorPicker } from "react-colorful";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Expande "#abc" para "#aabbcc" e valida; null se não for hex. */
export function normalizeHex(raw: string): string | null {
  const m = HEX_RE.exec(raw.trim());
  if (!m) return null;
  const h = m[1];
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  return `#${full.toLowerCase()}`;
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const n = parseInt(norm.slice(1), 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = [
    [v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q],
  ][i % 6];
  return { r: r * 255, g: g * 255, b: b * 255 };
}

/**
 * Cor atual do DP 24 de um bulbo, quando o formato é reconhecível.
 * O backend grava "hsv16" (hhhhssssvvvv, 12 hex); muitos aparelhos
 * devolvem "rgb8" (rrggbbhhhhssvv, 14 hex). Qualquer outra coisa: null.
 */
export function colorFromDps(dps: Record<string, unknown>): string | null {
  const raw = String(dps["24"] ?? "").trim();
  if (!/^[0-9a-fA-F]+$/.test(raw)) return null;
  if (raw.length === 12) {
    const h = parseInt(raw.slice(0, 4), 16) / 360;
    const s = parseInt(raw.slice(4, 8), 16) / 1000;
    const v = parseInt(raw.slice(8, 12), 16) / 1000;
    const rgb = hsvToRgb(Math.min(h, 1), Math.min(s, 1), Math.min(v, 1));
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  }
  if (raw.length === 14) return `#${raw.slice(0, 6).toLowerCase()}`;
  return null;
}

/**
 * Seletor de cor do bulbo: área de saturação/valor arrastável, barra de
 * matiz, hex e R/G/B manuais (react-colorful, que já trata pointer/touch
 * e clampa as coordenadas). Substitui os dois <input type=range> nativos,
 * que não mostravam a cor escolhida nem aceitavam valor exato.
 *
 * A caixinha é um dropdown simples (position absolute + clique-fora/Esc);
 * não abre rota nem diálogo por cima do card.
 */
export default function ColorPicker({
  color, onColorChange, onApply, disabled, applying,
}: {
  color: string;
  onColorChange: (hex: string) => void;
  onApply: () => void;
  disabled?: boolean;
  applying?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [openUp, setOpenUp] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const rgb = hexToRgb(color) ?? { r: 255, g: 209, b: 102 };

  // Sem espaço abaixo do swatch, a caixinha abre para cima — senão ela
  // nasceria fora da tela em cards perto do fim da página.
  function toggle() {
    const next = !open;
    if (next && rootRef.current) {
      const rect = rootRef.current.getBoundingClientRect();
      setOpenUp(window.innerHeight - rect.bottom < 440);
    }
    setOpen(next);
  }

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function emit(raw: string) {
    // passa como veio: o HexColorInput só emite com 3 ou 6 dígitos válidos
    // (normalizar o atalho de 3 no meio da digitação embaralharia o campo)
    onColorChange(raw);
  }

  function setChannel(ch: "r" | "g" | "b", value: string) {
    const n = Number(value);
    if (!Number.isFinite(n)) return;
    onColorChange(
      rgbToHex(ch === "r" ? n : rgb.r, ch === "g" ? n : rgb.g, ch === "b" ? n : rgb.b),
    );
  }

  return (
    <div ref={rootRef} className="relative">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-9 gap-2 pl-2 pr-2.5"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label="escolher cor"
        onClick={toggle}
      >
        <span
          aria-hidden
          className="size-5 shrink-0 rounded-md border border-white/20 shadow-inner"
          style={{ backgroundColor: color }}
        />
        <span className="font-mono text-[11px] uppercase tabular-nums">
          {normalizeHex(color) ?? color}
        </span>
        <Palette className="size-3.5 text-muted-foreground" />
      </Button>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="seletor de cor"
          className={`absolute left-0 z-50 w-[248px] space-y-3 rounded-xl border border-white/[0.08] bg-surface-container-low/95 p-3 shadow-2xl backdrop-blur-xl ${
            openUp ? "bottom-full mb-2" : "top-full mt-2"
          }`}
        >
          <HexColorPicker color={color} onChange={emit} />

          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
              #
            </span>
            <HexColorInput
              color={color}
              onChange={emit}
              prefixed={false}
              className="h-8 w-full rounded-md border border-outline-variant/40 bg-surface-container-high pl-6 pr-2 font-mono text-xs uppercase tabular-nums text-on-surface outline-none focus:border-primary"
              aria-label="código hex"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            {([
              ["r", "R", rgb.r],
              ["g", "G", rgb.g],
              ["b", "B", rgb.b],
            ] as const).map(([ch, label, value]) => (
              <div key={ch} className="space-y-1">
                <Label htmlFor={`${panelId}-${ch}`} className="text-[10px] text-muted-foreground">
                  {label}
                </Label>
                <Input
                  id={`${panelId}-${ch}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={255}
                  value={value}
                  onChange={(e) => setChannel(ch, e.target.value)}
                  className="h-8 text-center font-mono text-xs tabular-nums"
                />
              </div>
            ))}
          </div>

          <Button
            type="button"
            size="sm"
            className="w-full"
            disabled={disabled || applying}
            onClick={() => {
              onApply();
              setOpen(false);
            }}
          >
            {applying ? "aplicando…" : (
              <>
                <Check className="size-3.5" /> Aplicar cor
              </>
            )}
          </Button>

          <p className="text-center font-mono text-[10px] text-muted-foreground">
            rgb({rgb.r}, {rgb.g}, {rgb.b})
          </p>
        </div>
      )}
    </div>
  );
}
