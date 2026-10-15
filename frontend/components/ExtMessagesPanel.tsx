"use client";

import { useQuery } from "@tanstack/react-query";
import {
  Bell, BellRing, Loader2, MailWarning, MoonStar, RefreshCw,
} from "lucide-react";
import {
  SWITCH_LABELS, ipcMessages, ipcNotices,
} from "@/lib/ext/ipc";
import { useNotify } from "@/lib/query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * CENTRAL DE MENSAGENS / NOTIFICACOES — o que a conta tem de nao lido.
 *
 * Fontes (todas testadas ao vivo, v1.0 salvo nota):
 *   - `smartlife.m.msg.new` {} -> {alarm, family, notification} (booleano
 *     por categoria; nesta conta family+notification estao acesos)
 *   - `smartlife.m.msg.notice.switch.status` {"type": int 1..6} -> on/off
 *     por categoria de push
 *   - `smartlife.m.notice.new.get` {} -> bool (ha aviso novo?)
 *   - `m.message.device.alarm.nodisturb.list` v3.0 (e SO v3.0) -> [] aqui
 *
 * Nao lidas ficam marcadas visualmente (ponto + badge "novo"); lidas ficam
 * apagadas. Nada de credencial passa por aqui.
 */

const UNREAD_ORDER = ["alarm", "family", "notification"] as const;

const UNREAD_LABELS: Record<string, string> = {
  alarm: "Alarme",
  family: "Família",
  notification: "Notificação",
};

function ErrorBox({ message }: { message: string }) {
  return (
    <p className="rounded-lg bg-rose-400/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-rose-300/90">
      {message}
    </p>
  );
}

function MessagesCard() {
  const q = useQuery({
    queryKey: ["ext-ipc-messages"],
    queryFn: ipcMessages,
    refetchInterval: 60_000,
    retry: 1,
  });
  const d = q.data;

  return (
    <Card className="border-primary/20 bg-card/60 backdrop-blur">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-0">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <MailWarning className="size-4" />
          </div>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Mensagens — não lidas
              {d && d.unread_count > 0 && (
                <Badge variant="default">{d.unread_count} novas</Badge>
              )}
              {d && d.unread_count === 0 && (
                <Badge variant="secondary">tudo lido</Badge>
              )}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              smartlife.m.msg.new · {q.isPending ? "consultando…" : d ? `${d.switches_on}/${d.switches.length} categorias ligadas` : "sem resposta"}
            </CardDescription>
          </div>
        </div>
        {q.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </CardHeader>

      <CardContent className="space-y-2 pt-4">
        {q.isPending && (
          <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> lendo msg.new…
          </p>
        )}
        {q.error != null && <ErrorBox message={(q.error as Error).message} />}
        {d && (
          <>
            <ul className="space-y-1.5">
              {UNREAD_ORDER.map((k) => {
                const unread = d.unread[k] === true;
                return (
                  <li
                    key={k}
                    className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
                      unread
                        ? "border-primary/40 bg-primary/10"
                        : "border-border/50 bg-background/40 opacity-60"
                    }`}
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${unread ? "bg-primary" : "bg-border"}`}
                      title={unread ? "não lido" : "lido"}
                    />
                    <span className={`flex-1 text-xs ${unread ? "font-semibold" : "font-normal text-muted-foreground"}`}>
                      {UNREAD_LABELS[k] ?? k}
                    </span>
                    <Badge variant={unread ? "default" : "secondary"} className="text-[10px]">
                      {unread ? "novo" : "lido"}
                    </Badge>
                  </li>
                );
              })}
            </ul>

            <Separator />

            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Push por categoria (switch.status)
            </p>
            <ul className="space-y-1.5">
              {d.switches.map((s) => (
                <li
                  key={s.type}
                  className="flex items-center gap-3 rounded-md border border-border/50 bg-background/40 px-3 py-2"
                >
                  <Bell className={`size-3.5 shrink-0 ${s.on ? "text-primary" : "text-muted-foreground"}`} />
                  <span className="flex-1 truncate text-xs">
                    {SWITCH_LABELS[s.type] ?? `tipo ${s.type}`}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">type {s.type}</span>
                  <Badge variant={s.on ? "default" : "secondary"} className="text-[10px]">
                    {s.on ? "ligado" : "desligado"}
                  </Badge>
                </li>
              ))}
            </ul>

            {Object.keys(d.errors ?? {}).length > 0 && (
              <p className="font-mono text-[10px] leading-relaxed text-amber-200/80">
                falharam: {Object.entries(d.errors).map(([k, v]) => `${k.split("#")[0].split(".").pop()} (${String(v).split(" ")[0]})`).join(", ")}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function NoticesCard() {
  const q = useQuery({
    queryKey: ["ext-ipc-notices"],
    queryFn: ipcNotices,
    refetchInterval: 60_000,
    retry: 1,
  });
  const d = q.data;

  return (
    <Card className="border-primary/20 bg-card/60 backdrop-blur">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-0">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            {d?.new_notice ? <BellRing className="size-4" /> : <Bell className="size-4" />}
          </div>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              Avisos e não perturbe
              {d?.new_notice === true && <Badge variant="default">aviso novo</Badge>}
              {d?.new_notice === false && <Badge variant="secondary">sem aviso novo</Badge>}
            </CardTitle>
            <CardDescription className="font-mono text-xs">
              notice.new.get · nodisturb.list v3.0 · {d ? `${d.nodisturb_count} em não perturbe` : "sem resposta"}
            </CardDescription>
          </div>
        </div>
        {q.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      </CardHeader>

      <CardContent className="space-y-3 pt-4">
        {q.isPending && (
          <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> lendo avisos…
          </p>
        )}
        {q.error != null && <ErrorBox message={(q.error as Error).message} />}
        {d && (
          <>
            <div
              className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
                d.new_notice ? "border-primary/40 bg-primary/10" : "border-border/50 bg-background/40 opacity-60"
              }`}
            >
              <span className={`size-2 shrink-0 rounded-full ${d.new_notice ? "bg-primary" : "bg-border"}`} />
              <span className={`flex-1 text-xs ${d.new_notice ? "font-semibold" : "text-muted-foreground"}`}>
                {d.new_notice ? "Há aviso novo nesta conta" : "Nenhum aviso novo"}
              </span>
              <Badge variant={d.new_notice ? "default" : "secondary"} className="text-[10px]">
                {d.new_notice ? "novo" : "lido"}
              </Badge>
            </div>

            <Separator />

            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <MoonStar className="size-3.5" /> Não perturbe por device
            </p>
            {d.nodisturb.length === 0 ? (
              <p className="rounded-lg bg-secondary/40 px-3 py-4 text-center text-xs text-muted-foreground">
                Nenhum device em não perturbe — a lista veio vazia da Tuya.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {d.nodisturb.map((n) => (
                  <li
                    key={n.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/50 bg-background/40 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">{n.name}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">{n.id}</span>
                    </span>
                    <Badge variant={n.enabled ? "default" : "secondary"} className="text-[10px]">
                      {n.enabled ? "ativo" : "inativo"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}

            {Object.keys(d.errors ?? {}).length > 0 && (
              <p className="font-mono text-[10px] leading-relaxed text-amber-200/80">
                falharam: {Object.entries(d.errors).map(([k, v]) => `${k.split(".").pop()} (${String(v).split(" ")[0]})`).join(", ")}
              </p>
            )}
          </>
        )}
      </CardContent>

      <CardFooter className="border-t border-border/50 px-6 py-2.5">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          m.message.device.alarm.nodisturb.list só responde na v3.0
        </span>
      </CardFooter>
    </Card>
  );
}

export default function ExtMessagesPanel() {
  const notify = useNotify();
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Mensagens e notificações</h2>
          <p className="text-xs text-muted-foreground">
            gateway móvel Tuya · não lidas marcadas visualmente
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => Promise.all([ipcMessages(), ipcNotices()])
            .then(([m, n]) => notify(
              `não lidas: ${m.unread_count} · aviso novo: ${n.new_notice ? "sim" : "não"} · não perturbe: ${n.nodisturb_count}`,
              "ok",
            ))
            .catch((e) => notify(`falhou: ${(e as Error).message}`, "err"))}
        >
          <RefreshCw className="size-3.5" />
          Atualizar
        </Button>
      </div>
      <MessagesCard />
      <NoticesCard />
    </div>
  );
}
