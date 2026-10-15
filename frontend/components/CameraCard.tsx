"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Camera, CloudOff, Loader2, MonitorDot, Play, RefreshCw, Square, Wifi,
} from "lucide-react";
import {
  useCamProbe, useCamSources, useCamStreamStatus, useCloudStatus,
} from "@/hooks/useCloud";
import { api, codecName, type Device, type P2pFacts, type RtspSource } from "@/lib/api";
import { useConfig } from "@/hooks/useConfig";
import { useNotify } from "@/lib/query";
import CameraPlayer from "@/components/CameraPlayer";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const WIDTHS = [
  { w: 640, label: "SD · 640" },
  { w: 960, label: "Médio · 960" },
  { w: 1280, label: "HD · 1280" },
];

function pickSource(sources: RtspSource[]): RtspSource | null {
  if (sources.length === 0) return null;
  return sources.find((s) => /\/hd$/i.test(s.path ?? "")) ?? sources[0];
}

/** Rótulo curto do estado real da mídia, pelo Go (não pelo registro). */
function mediaLabel(s: RtspSource | undefined): { text: string; cls: string } {
  switch (s?.media_state) {
    case "live":
      return {
        text: `transmitindo · ${s.packets ?? 0} RTP`,
        cls: "bg-secondary-container/20 text-mint",
      };
    case "connecting":
      return { text: "negociando…", cls: "bg-surface-container-high text-on-surface-variant" };
    case "stalled":
      return { text: "sem mídia", cls: "bg-error/15 text-error" };
    default:
      return { text: "parada", cls: "bg-surface-container-high text-on-surface-variant" };
  }
}

const BADGE = "rounded-full px-2.5 py-0.5 text-[11px] font-medium";

export default function CameraCard({ device }: { device: Device }) {
  const notify = useNotify();
  const srcQ = useCamSources();
  const probe = useCamProbe();
  // sessão no bundle? é o que faz a ponte de vídeo subir sozinha
  const { data: cloudStatus } = useCloudStatus();
  const cloudOk = Boolean(cloudStatus?.logged_in || cloudStatus?.rtsp?.alive);

  const sources = srcQ.data;
  const rtspReady = Boolean(sources?.alive && sources.sources.length);
  const bridgeError =
    (sources?.error || sources?.log || "").split("\n").filter(Boolean).pop() ?? "";
  const bridgeStarting = cloudOk && !sources?.alive && !bridgeError;
  const autoSource = useMemo(() => pickSource(srcQ.data?.sources ?? []), [srcQ.data]);

  const { data: cfg } = useConfig();

  const [streamOn, setStreamOn] = useState(false);
  const [srcOverride, setSrcOverride] = useState<string | null>(null);
  const [width, setWidth] = useState(640);
  const [reconnect, setReconnect] = useState(0);
  const [imgBroken, setImgBroken] = useState(false);
  /**
   * Pausa desconecta o <img> de verdade (o backend para de escrever) — e por
   * isso a recuperação automática e o poll de status ficam desligados; retomar
   * reconecta com um `k=` novo, já vivo.
   */
  const [paused, setPaused] = useState(false);
  const [recording, setRecording] = useState(false);

  /** Reabrir o stream: usado tanto pelo botão quanto pela recuperação. */
  function reopen() {
    setStreamOn((v) => !v || true);
    setImgBroken(false);
    setReconnect((n) => n + 1);
  }

  const chosen = useMemo<RtspSource | null>(() => {
    if (!rtspReady) return null;
    return (srcQ.data?.sources ?? []).find((s) => s.path === srcOverride) ?? autoSource;
  }, [rtspReady, srcQ.data, srcOverride, autoSource]);

  const streamPath = chosen?.path ?? "";
  // pausado, o stream está fechado de propósito: nada de poll/diagnóstico
  const status = useCamStreamStatus(streamPath, streamOn && !paused, 2500);
  const live = status.data?.streams?.[0];

  /**
   * Recuperação automática: o backend já reconstrói a ponte (watchdog). Aqui
   * só reagimos ao diagnóstico — quando ele diz `relogin`, reconectar o
   * `<img>` não adianta e a UI precisa dizer isso.
   */
  const diag = status.data?.diagnosis;
  const watchdog = status.data?.watchdog;
  // `last_action` já vem com o instante da ação; a idade sai do relógio do
  // próprio dado (`dataUpdatedAt` do react-query), não de `Date.now()` no
  // render — impureza que o lint do React 19 rejeita.
  const recovering = Boolean(watchdog?.last_action) &&
    watchdog?.last_action_at != null &&
    (status.dataUpdatedAt / 1000) - watchdog.last_action_at < 90;
  const needsRelogin = (status.data?.action === "relogin" || diag?.action === "relogin") &&
    Boolean(status.data?.error);

  const fails = (live?.history ?? []).filter((h) => /error|timed|falha/i.test(h)).length;
  useEffect(() => {
    // pausado não reconecta sozinho: o stream fechado é intencional
    if (!streamOn || paused || needsRelogin || fails < 2) return;
    const t = setTimeout(() => {
      setReconnect((n) => n + 1);
      setImgBroken(false);
    }, 2500);
    return () => clearTimeout(t);
  }, [streamOn, paused, fails, needsRelogin, live?.history.length]);

  const p2p = cfg?.p2p && "p2p_type" in cfg.p2p ? (cfg.p2p as P2pFacts) : null;
  const mode: "rtsp" | "sem-fonte" = rtspReady ? "rtsp" : "sem-fonte";
  const imgKey = `${mode}|${streamPath}|${width}|${streamOn ? 1 : 0}|${reconnect}`;
  /**
   * O URL do stream é congelado por (fonte, largura, k): `camStreamUrl` embute
   * um `t=Date.now()` e, recalculado a cada render, trocava o atributo `src`
   * do <img> a cada poll — o navegador cancelava e reabria o multipart sem
   * parar. Reconectar é papel do `k` (e do remonte pelo `imgKey`).
   */
  const imgSrc = useMemo(
    () => `${api.camStreamUrl({ path: streamPath, width })}&k=${reconnect}`,
    [streamPath, width, reconnect],
  );

  const streamState = paused
    ? "paused"
    : imgBroken || (live && live.state === "error" && live.frames === 0)
      ? "error"
      : streamOn
        ? (live?.state ?? "connecting")
        : "idle";

  /** Texto do overlay: causa > erro cru do leitor. */
  const overlayText = needsRelogin
    ? (status.data?.error ?? "sessão expirada")
    : recovering
      ? `${watchdog?.last_action}…`
      : (live?.error ?? diag?.cause ?? "abrindo o stream…");

  const stateBadge =
    streamState === "live"
      ? { text: "ao vivo", cls: "bg-secondary-container/30 text-mint" }
      : streamState === "error"
        ? { text: "erro", cls: "bg-error/15 text-error" }
        : streamState === "paused"
          ? { text: "pausado", cls: "bg-tertiary-container/20 text-tertiary" }
          : streamState === "idle"
            ? { text: "parada", cls: "bg-surface-container-high text-on-surface-variant" }
            : { text: "conectando…", cls: "bg-surface-container-high text-on-surface-variant" };

  return (
    <div className="flex flex-col gap-4 rounded-xl bg-surface-container-low p-4 shadow-xl backdrop-blur-md">
      {/* cabeçalho */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
            <Camera className="size-[22px]" />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight text-on-surface">
              {device.name}
            </h2>
            <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-on-surface-variant">
              <span
                className={`size-1.5 rounded-full ${
                  streamState === "live" ? "animate-ping bg-mint" : "bg-outline"
                }`}
              />
              {device.ip ?? "sem IP"} · P2P tipo {p2p?.p2p_type ?? 4} · sem porta na LAN
            </span>
          </div>
        </div>
        <span className={`${BADGE} ${stateBadge.cls}`}>{stateBadge.text}</span>
      </div>

      {/* controles */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={(streamOn && !chosen) || recording}
          title={recording ? "pare a gravação antes de fechar o stream" : undefined}
          onClick={() => {
            setStreamOn((v) => !v);
            setImgBroken(false);
            setPaused(false);
            setReconnect((n) => n + 1);
            if (!streamOn) {
              notify(
                rtspReady
                  ? `abrindo ${chosen?.name ?? chosen?.path}`
                  : "sem fonte RTSP — faça login na nuvem e suba o start_cam",
                rtspReady ? "ok" : "err",
              );
            }
          }}
          className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[12px] font-medium text-on-primary shadow-[0_0_16px_rgba(76,215,246,0.3)] transition-all hover:bg-primary-fixed-dim active:scale-95 disabled:opacity-60"
        >
          {streamOn ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
          {streamOn ? "Parar" : "Ver ao vivo"}
        </button>

        {rtspReady && (
          <Select value={streamPath} onValueChange={setSrcOverride}>
            <SelectTrigger className="h-9 w-44 border-outline-variant/40 bg-surface-container-high text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="border-outline-variant/40 bg-surface-container-low">
              {srcQ.data!.sources.map((s) => (
                <SelectItem key={s.path} value={s.path}>
                  {s.name ?? s.path}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={String(width)}
          onValueChange={(v) => {
            setWidth(Number(v));
            setReconnect((n) => n + 1);
          }}
        >
          <SelectTrigger className="h-9 w-32 border-outline-variant/40 bg-surface-container-high text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-outline-variant/40 bg-surface-container-low">
            {WIDTHS.map((w) => (
              <SelectItem key={w.w} value={String(w.w)}>
                {w.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          className="h-9 border-outline-variant/40 bg-surface-container-high text-xs text-on-surface hover:bg-surface-bright"
          disabled={!rtspReady || probe.isPending}
          onClick={() =>
            probe
              .mutateAsync(streamPath)
              .then((r) =>
                notify(
                  r.probe?.ok
                    ? `stream ok: ${r.probe.codec} ${r.probe.size}`
                    : `stream indisponível: ${r.probe?.error ?? "sem quadros"}`,
                  r.probe?.ok ? "ok" : "err",
                ),
              )
              .catch((e) => notify(`sonda falhou: ${e}`, "err"))
          }
        >
          {probe.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Wifi className="size-3.5" />}
          Testar
        </Button>
      </div>

      {streamOn && (
        <CameraPlayer
          src={imgSrc}
          streamKey={imgKey}
          deviceName={device.name}
          paused={paused}
          onPause={() => setPaused(true)}
          onResume={() => {
            // retomar = voltar ao vivo: reconecta com uma sessão nova
            setPaused(false);
            setImgBroken(false);
            setReconnect((n) => n + 1);
          }}
          imgBroken={imgBroken}
          onImgBroken={() => setImgBroken(true)}
          streamState={streamState}
          overlayText={overlayText}
          needsRelogin={needsRelogin}
          onRetry={reopen}
          onRecordingChange={setRecording}
        />
      )}

      {/* telemetria real do stream */}
      <div className="flex flex-wrap gap-1.5">
        <span className={`${BADGE} ${rtspReady ? "bg-secondary-container/20 text-mint" : "bg-surface-container-high text-on-surface-variant"}`}>
          {rtspReady
            ? "RTSP real (nuvem/P2P)"
            : bridgeStarting
              ? "subindo a ponte…"
              : srcQ.data?.alive
                ? "ponte no ar, sem câmera"
                : "sem fonte RTSP"}
        </span>
        {chosen && <span className={`${BADGE} ${mediaLabel(chosen).cls}`}>{mediaLabel(chosen).text}</span>}
        {live?.codec && (
          <span className={`${BADGE} bg-surface-container-high font-mono text-primary`}>{live.codec}</span>
        )}
        {live?.size && (
          <span className={`${BADGE} bg-surface-container-high font-mono text-on-surface-variant`}>{live.size}</span>
        )}
        {live?.fps ? (
          <span className={`${BADGE} bg-surface-container-high font-mono text-mint`}>{live.fps} fps</span>
        ) : null}
        {live?.frames ? (
          <span className={`${BADGE} bg-surface-container-high font-mono text-on-surface-variant`}>
            {live.frames} quadros
          </span>
        ) : null}
        {live?.first_frame_in != null && (
          <span className={`${BADGE} bg-surface-container-high font-mono text-on-surface-variant`}>
            1º quadro em {live.first_frame_in}s
          </span>
        )}
        {live?.dry_for != null && streamState !== "live" && streamState !== "paused" && (
          <span className={`${BADGE} bg-surface-container-high font-mono text-tertiary`}>
            {(live.dry_for ?? 0).toFixed(0)}s sem quadro
          </span>
        )}
        {(watchdog?.restart_count ?? 0) > 0 && (
          <span
            className={`${BADGE} bg-surface-container-high font-mono text-tertiary`}
            title={watchdog?.restart_log.join(" · ")}
          >
            {watchdog?.restart_count} recuperações
          </span>
        )}
      </div>

      {/* Erro acionável: causa + o que fazer. Antes era só InvalidDataError,
          que não dizia se o problema era sessão, MQTT, rede ou permissão. */}
      {(needsRelogin || (cloudOk && !rtspReady && !bridgeStarting)) && !paused && (
        <div className="rounded-lg border border-tertiary/30 bg-tertiary-container/10 px-3 py-2.5 text-[11px] leading-relaxed text-tertiary">
          <p className="font-semibold">
            {needsRelogin ? "A sessão precisa ser refeita" : "A ponte de vídeo falhou"}
          </p>
          <p className="font-mono">
            {status.data?.error || sources?.error || bridgeError || "sem resposta do processo de RTSP"}
          </p>
          {(diag?.fix || status.data?.action === "relogin") && (
            <p className="mt-1">
              → {diag?.fix ?? "refaça o login com e-mail e senha (o login por QR não traz accessToken, e sem ele a câmera não tem MQTT)"}
            </p>
          )}
          {watchdog?.last_action && (
            <p className="mt-1 font-mono opacity-80">
              watchdog: {watchdog.last_action}
              {watchdog.restart_log?.length ? ` · ${watchdog.restart_log.at(-1)}` : ""}
            </p>
          )}
          {!needsRelogin && (
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-8 border-outline-variant/40 bg-surface-container-high text-xs"
              onClick={reopen}
            >
              <RefreshCw className="size-3.5" />
              Reconstruir ponte
            </Button>
          )}
        </div>
      )}

      {/* rodapé técnico: por que não existe RTSP local */}
      <div className="flex flex-col gap-1.5 border-t border-white/[0.06] pt-3 text-[11px] leading-relaxed text-on-surface-variant">
        <p>
          <MonitorDot className="mr-1 inline size-3" />
          Não existe RTSP local: a câmera não abre nenhuma porta na LAN (22/80/443/
          554/8000/8080 fechados). O app mostra vídeo fora do WiFi via{" "}
          <strong className="text-on-surface">P2P tipo {p2p?.p2p_type ?? "?"}</strong>
          {p2p?.is_cloud_p2p === false ? " (não é relay de nuvem)" : ""} —{" "}
          {(p2p?.transmission ?? "kcp").toUpperCase()} sobre relay TCP
          {p2p?.tcp_relay?.length ? ` (${p2p.tcp_relay.join(", ")})` : ""},{" "}
          {p2p?.codecs?.length
            ? p2p.codecs.map((c) => `${codecName(c.codec_type)} ${c.size}`).join(" + ")
            : "vídeo H.264"}
          {p2p?.sdk_version ? ` · SDK ${p2p.sdk_version}` : ""}.
        </p>
        <p className="font-mono">
          {srcQ.isPending
            ? "verificando fontes…"
            : rtspReady
              ? `${srcQ.data!.sources.length} fonte(s) em ${srcQ.data!.base}`
              : `RTSP ${srcQ.data?.base ?? "—"} · ${bridgeError || "aguardando sessão"}`}
          {paused
            ? " · pausado no frame congelado (retomar reconecta)"
            : live?.state === "live"
              ? ` · ao vivo${live.frames ? ` · ${live.frames} quadros` : ""}`
              : live?.history?.length
                ? ` · ${live.history[live.history.length - 1]}`
                : ""}
        </p>
      </div>
    </div>
  );
}

/** selo usado pela lista lateral quando não há sessão/câmera */
export function NoSessionBadge() {
  return (
    <span className="flex items-center gap-2 rounded-xl bg-surface-container-lowest p-3 text-[11px] text-on-surface-variant">
      <CloudOff className="size-4 text-outline" />
      câmera fora da lista — a ponte sobe quando chega sessão no navegador
    </span>
  );
}
