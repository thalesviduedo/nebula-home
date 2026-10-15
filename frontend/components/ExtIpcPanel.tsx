"use client";

import { useQuery } from "@tanstack/react-query";
import {
  AudioLines, Camera, Cog, Loader2, MonitorDot, Radio, RefreshCw,
  ShieldCheck, Video,
} from "lucide-react";
import {
  CLARITY_NAMES, STREAM_NAMES, ipcCaps, type IpcCaps,
} from "@/lib/ext/ipc";
import { useNotify } from "@/lib/query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/**
 * O que a camera RESPONDE que suporta — nao o que a gente assume que ela faz.
 * Toda linha sai de uma API testada ao vivo; o rodape lista as rotas que
 * falharam em vez de esconder.
 */
function Row({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={`text-right font-mono text-xs ${ok ? "text-foreground" : "text-muted-foreground line-through"}`}
      >
        {value}
      </span>
    </div>
  );
}

function Section({ icon: Icon, title, children }: {
  icon: typeof Camera;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Icon className="size-3.5 text-primary" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
      </div>
      {children}
    </div>
  );
}

export default function ExtIpcPanel({ deviceId }: { deviceId?: string }) {
  const notify = useNotify();
  const q = useQuery<IpcCaps>({
    queryKey: ["ext-ipc-caps", deviceId ?? ""],
    queryFn: () => ipcCaps(deviceId),
    refetchInterval: 60_000,
    retry: 1,
  });

  const d = q.data;
  const p2p = d?.p2p;
  const failed = Object.entries(d?.errors ?? {});

  return (
    <Card className="gap-4 border-primary/20 bg-card/60 backdrop-blur">
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-0">
        <div className="flex items-center gap-3">
          <div className="grid size-9 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Camera className="size-4" />
          </div>
          <div>
            <CardTitle className="text-base">Câmera — capacidades</CardTitle>
            <CardDescription className="font-mono text-xs">
              {q.isPending
                ? "consultando o gateway móvel…"
                : d
                  ? `${d.device.name} · ${d.device.id}`
                  : (q.error as Error)?.message ?? "sem resposta"}
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {q.isFetching && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              q.refetch()
                .then((r) => notify(
                  r.data?.sources
                    ? Object.entries(r.data.sources)
                        .map(([k, v]) => `${k.split(".").pop()}=${v}`).join(" · ")
                    : "sem fontes",
                  "ok",
                ))
                .catch((e) => notify(`falhou: ${e}`, "err"));
            }}
          >
            <RefreshCw className="size-3.5" />
            Recarregar
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {q.isPending && (
          <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            buscando m.ipc.v4.rtc.config.get…
          </p>
        )}

        {q.error != null && (
          <p className="rounded-lg bg-rose-400/10 px-3 py-2 font-mono text-[11px] leading-relaxed text-rose-300/90">
            {(q.error as Error).message}
          </p>
        )}

        {d && p2p && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="default">P2P tipo {p2p.p2p_type}</Badge>
              <Badge variant="outline">{(p2p.transmission || "?").toUpperCase()}</Badge>
              <Badge variant={p2p.supports_webrtc ? "default" : "secondary"}>
                {p2p.supports_webrtc ? "WebRTC" : "sem WebRTC"}
              </Badge>
              {p2p.is_cloud_p2p && <Badge variant="outline">relay de nuvem</Badge>}
              {p2p.is_4g_device && <Badge variant="outline">4G</Badge>}
              {p2p.preconnect && <Badge variant="outline">preconnect</Badge>}
              {p2p.supports_webrtc_record && <Badge variant="outline">grava pela web</Badge>}
              {d.cached && <Badge variant="secondary">cache 30s</Badge>}
            </div>

            <Section icon={Video} title="Resoluções que o aparelho suporta">
              {p2p.videos.length === 0 ? (
                <p className="font-mono text-[11px] text-muted-foreground">
                  o firmware não declarou streams de vídeo
                </p>
              ) : (
                <div className="space-y-1">
                  {p2p.videos.map((v) => (
                    <div
                      key={`${v.stream_type}-${v.size}`}
                      className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/40 px-2.5 py-1.5"
                    >
                      <span className="text-xs">
                        <span className="font-mono text-muted-foreground">
                          stream {v.stream_type}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          ({STREAM_NAMES[v.stream_type] ?? "?"})
                        </span>
                      </span>
                      <span className="font-mono text-xs">{v.size || `${v.width}x${v.height}`}</span>
                      <Badge variant="outline">{v.codec}</Badge>
                    </div>
                  ))}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[11px] text-muted-foreground">claridades do firmware:</span>
                    {p2p.video_clarities.length === 0
                      ? <span className="font-mono text-[11px] text-muted-foreground">—</span>
                      : p2p.video_clarities.map((c) => (
                        <Badge key={c} variant="secondary">
                          {CLARITY_NAMES[c] ?? c}
                        </Badge>
                      ))}
                    {p2p.video_clarity != null && (
                      <span className="font-mono text-[11px] text-muted-foreground">
                        atual: {CLARITY_NAMES[p2p.video_clarity] ?? p2p.video_clarity}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </Section>

            <Separator />

            <div className="grid gap-5 sm:grid-cols-2">
              <Section icon={AudioLines} title="Áudio / two-way talk">
                {p2p.audios.map((a) => (
                  <Row key={a.codec_type} label={`codec ${a.codec_type}`} value={a.codec} ok />
                ))}
                {p2p.audios.map((a) => (
                  <Row
                    key={`${a.codec_type}-sr`}
                    label="amostragem"
                    value={`${a.sample_rate} Hz · ${a.channels} canal(is)`}
                    ok
                  />
                ))}
                <Row
                  label="interfone (two-way)"
                  value={d.two_way ? (d.two_way.enable ? "habilitado" : "desabilitado") : "—"}
                  ok={Boolean(d.two_way?.enable)}
                />
                <Row
                  label="callMode"
                  value={p2p.audio_attributes.call_modes.join(", ") || "—"}
                  ok={p2p.audio_attributes.call_modes.length > 0}
                />
                <Row
                  label="hardwareCapability"
                  value={p2p.audio_attributes.hardware_capability.join(", ") || "—"}
                  ok={p2p.audio_attributes.hardware_capability.length > 0}
                />
              </Section>

              <Section icon={Cog} title="Config e serviços">
                <Row
                  label="smart image quality"
                  value={d.smart_image_quality === null ? "—" : d.smart_image_quality ? "suportado" : "não suportado"}
                  ok={Boolean(d.smart_image_quality)}
                />
                <Row
                  label="status AP"
                  value={d.ap?.business_result === null || d.ap === null
                    ? "—"
                    : d.ap.business_result ? "businessResult true" : "businessResult false"}
                  ok={Boolean(d.ap?.business_result)}
                />
                <Row
                  label="painel de ajustes"
                  value={d.ui?.setting_panel_version || "—"}
                  ok={Boolean(d.ui?.setting_panel_version)}
                />
                <Row
                  label="tema do painel"
                  value={d.ui?.setting_theme || "—"}
                  ok={Boolean(d.ui?.setting_theme)}
                />
                <Row label="SDK" value={p2p.skill.sdk_version || "—"} ok />
                <Row
                  label="zoom digital"
                  value={p2p.max_zoom_in_times ? `${p2p.max_zoom_in_times}x` : "não"}
                  ok={Boolean(p2p.max_zoom_in_times)}
                />
              </Section>
            </div>

            <Separator />

            <Section icon={Radio} title="Como o vídeo chega (infraestrutura, sem credencial)">
              <div className="space-y-1">
                <Row
                  label="ICE"
                  value={p2p.ice_hosts.join(" · ") || "—"}
                  ok={p2p.ice_hosts.length > 0}
                />
                <Row
                  label="relay TCP"
                  value={p2p.relay_urls.join(" · ") || "—"}
                  ok={p2p.relay_urls.length > 0}
                />
                <Row label="cloud storage" value={String(p2p.skill.cloud_storage)} ok />
              </div>
            </Section>
          </>
        )}
      </CardContent>

      <CardFooter className="flex-col items-start gap-1.5 border-t border-border/50 px-6 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        <p>
          <ShieldCheck className="mr-1 inline size-3" />
          A API de RTC devolve a sessão P2P completa (auth, aesKey, icePassword,
          credential do TURN). O backend reconstrói a resposta campo a campo e
          descarta tudo que é credencial — aqui só chega capacidade e
          host:port.
        </p>
        <p className="font-mono">
          <MonitorDot className="mr-1 inline size-3" />
          {d
            ? `${Object.values(d.sources).filter((v) => v === "ok").length}/${Object.keys(d.sources).length} rotas ok` +
              (failed.length ? ` · falharam: ${failed.map(([k, v]) => `${k.split(".").pop()} (${v.split(" ")[0]})`).join(", ")}` : "")
            : "aguardando o gateway"}
        </p>
      </CardFooter>
    </Card>
  );
}
