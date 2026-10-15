import type { Device } from "./api";

/**
 * Rótulo de estado de um device — FONTE ÚNICA para a tabela e o card.
 *
 * As duas visões já divergiram por terem regras próprias (a tabela dizia
 * "online/offline" para tudo; o card dizia "ligado/nuvem/sem sessão"). Um
 * mesmo aparelho, no mesmo instante, aparecia com nomes — e cores —
 * diferentes em cada lugar. Aqui a decisão é tomada uma vez só.
 */
export type StatusTone = "default" | "secondary" | "destructive" | "outline";

export interface DeviceStatus {
  label: string;
  tone: StatusTone;
  /** cor do quadradinho do ícone no card: aceso, apagado ou neutro */
  icon: "on" | "off" | "idle";
}

export function deviceStatus(d: Device): DeviceStatus {
  // Câmera: não tem DPS para sondar — o "online" dela é a PONTE DE VÍDEO no
  // ar (o backend devolve isso em `ok`, o mesmo sinal que a aba da câmera
  // usa). Antes o card dizia "vídeo" fixo e discordava da aba, que mostrava
  // online.
  if (d.kind === "cam")
    return d.ok
      ? { label: "online", tone: "default", icon: "idle" }
      : { label: "offline", tone: "destructive", icon: "idle" };

  // Blaster IR: não tem on/off; o "estado" é a capacidade de emitir
  // (sessão de nuvem). Pintar de vermelho "offline" era mentira.
  if (d.kind === "ir")
    return { label: d.ok ? "nuvem" : "sem sessão", tone: "outline", icon: "idle" };

  // Device que só existe pela nuvem: sem caminho de sondagem/controle local.
  // "offline" afirmaria algo que nunca foi medido; "nuvem" é o honesto.
  if (d.kind === "cloud")
    return d.ok
      ? { label: "online", tone: "default", icon: "idle" }
      : { label: "nuvem", tone: "secondary", icon: "idle" };

  if (!d.ok) return { label: "offline", tone: "destructive", icon: "idle" };
  return d.on
    ? { label: "ligado", tone: "default", icon: "on" }
    : { label: "desligado", tone: "secondary", icon: "off" };
}
