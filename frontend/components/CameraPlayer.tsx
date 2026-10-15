"use client";

/**
 * Player da câmera (MJPEG multipart via <img>).
 *
 * Por que sob medida: nenhum player React do mercado aceita
 * `multipart/x-mixed-replace` — react-player/video.js/mux-player trabalham com
 * <video>/HLS/DASH e o Plyr nunca suportou multipart (issue #2795). Os players
 * que existem são invólucros finos do mesmo <img> que já usamos aqui. Este
 * componente mantém o <img> anônimo (sem header/bundle — o backend não pode
 * ser derrubado) e constrói em volta dele os controles que faltavam:
 * pausa com quadro congelado, ajustes de imagem, gravação client-side.
 *
 * Decisões de engenharia (ver comentários pontuais):
 * - pausar NÃO mantém o stream aberto: o <img> é desmontado (o backend para de
 *   escrever) e o último quadro vira um canvas congelado; retomar reconecta;
 * - o ritmo de captura da gravação usa setInterval, não rAF (aba em segundo
 *   plano estrangula o rAF e pararia a captura de vez);
 * - brilho/contraste/saturação via função CSS (e `ctx.filter` no canvas);
 *   temperatura via SVG feColorMatrix (`filter: url(#id)`) — o MESMO filtro
 *   alimenta `ctx.filter` na foto/gravação, o que o Chrome suporta até em
 *   canvas destacado do DOM (conferido no ambiente; ver relatório);
 * - os ajustes NÃO persistem: `lib/no-persistence.ts` bloqueia escrita no
 *   storage (só a chave do bundle passa) — então são por card, em memória.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, Camera, Circle, Download, Loader2, Maximize, Minimize, Pause, Play,
  RefreshCw, RotateCcw, SlidersHorizontal, Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { useNotify } from "@/lib/query";

const CAPTURE_FPS = 20;
const VIDEO_BITRATE = 4_000_000;
/** ganho linear máximo por canal no balanço de branco (temperatura = ±100) */
const TEMP_GAIN = 0.35;
const MIMES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

const DEFAULTS = { brightness: 100, contrast: 100, saturation: 100, temperature: 0 };
type Adjust = typeof DEFAULTS;

function slug(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "camera"
  );
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function clock(total: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 60))}:${p(total % 60)}`;
}

function filterOf(a: Adjust, filterId: string): string {
  const chain = [
    `brightness(${a.brightness / 100})`,
    `contrast(${a.contrast / 100})`,
    `saturate(${a.saturation / 100})`,
  ];
  if (a.temperature !== 0) chain.push(`url(#${filterId})`);
  return chain.join(" ");
}

/** feColorMatrix diagonal: R sobe e B desce com a temperatura (g inverso). */
function tempMatrix(t: number): string {
  const gain = 1 + (t / 100) * TEMP_GAIN;
  return `${gain} 0 0 0 0  0 1 0 0 0  0 0 ${2 - gain} 0 0  0 0 0 1 0`;
}

export interface CameraPlayerProps {
  src: string;
  streamKey: string;
  deviceName: string;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  imgBroken: boolean;
  onImgBroken: () => void;
  streamState: string;
  overlayText: string;
  needsRelogin: boolean;
  onRetry: () => void;
  onRecordingChange: (recording: boolean) => void;
}

export default function CameraPlayer({
  src,
  streamKey,
  deviceName,
  paused,
  onPause,
  onResume,
  imgBroken,
  onImgBroken,
  streamState,
  overlayText,
  needsRelogin,
  onRetry,
  onRecordingChange,
}: CameraPlayerProps) {
  const notify = useNotify();
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const freezeRef = useRef<HTMLCanvasElement | null>(null);
  const frozenViewRef = useRef<HTMLCanvasElement>(null);
  const captureRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const drawTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);
  const clipUrlRef = useRef<string | null>(null);
  const aliveRef = useRef(true);

  const [adjust, setAdjust] = useState<Adjust>(DEFAULTS);
  const [showAdjust, setShowAdjust] = useState(false);
  const [frozenAt, setFrozenAt] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [clip, setClip] = useState<{ url: string; name: string; size: number } | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // o player só monta no cliente (o card abre o stream com um clique), então
  // dá para sondar o MediaRecorder já na criação do estado — sem efeito
  const [recInfo] = useState(() => {
    if (typeof MediaRecorder === "undefined") return { supported: false, mime: null as string | null };
    return {
      supported: true,
      mime: MIMES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null,
    };
  });
  const { supported: recSupported, mime: recMime } = recInfo;

  const filterId = `camf-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const cssFilter = useMemo(() => filterOf(adjust, filterId), [adjust, filterId]);
  const isDefault = useMemo(
    () => (Object.keys(DEFAULTS) as (keyof Adjust)[]).every((k) => adjust[k] === DEFAULTS[k]),
    [adjust],
  );

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (drawTimerRef.current) clearInterval(drawTimerRef.current);
      if (recTimerRef.current) clearInterval(recTimerRef.current);
      const rec = recorderRef.current;
      recorderRef.current = null;
      try {
        rec?.stop();
      } catch {
        /* já parado */
      }
      // o stream do canvas vive enquanto o player existir: parar as trilhas
      // evita capturas órfãs rodando em segundo plano
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    };
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  /** Desenha um quadro aplicando os ajustes — vale para tela, foto e gravação. */
  const drawFrame = useCallback(
    (ctx: CanvasRenderingContext2D, source: CanvasImageSource, w: number, h: number) => {
      ctx.filter = cssFilter;
      ctx.drawImage(source, 0, 0, w, h);
      ctx.filter = "none";
    },
    [cssFilter],
  );

  // congelado: redesenha o quadro congelado (cru) sempre que um ajuste muda
  useEffect(() => {
    if (!paused) return;
    const view = frozenViewRef.current;
    const raw = freezeRef.current;
    if (!view || !raw) return;
    view.width = raw.width;
    view.height = raw.height;
    const ctx = view.getContext("2d");
    if (ctx) drawFrame(ctx, raw, raw.width, raw.height);
  }, [paused, drawFrame]);

  function pause() {
    const img = imgRef.current;
    if (!img || !img.naturalWidth) {
      notify("ainda não há quadro para congelar", "err");
      return;
    }
    try {
      const raw = document.createElement("canvas");
      raw.width = img.naturalWidth;
      raw.height = img.naturalHeight;
      raw.getContext("2d")!.drawImage(img, 0, 0);
      freezeRef.current = raw;
    } catch {
      notify("não deu para congelar o quadro", "err");
      return;
    }
    setFrozenAt(new Date().toLocaleTimeString("pt-BR", { hour12: false }));
    onPause();
  }

  function resume() {
    setFrozenAt(null);
    onResume();
  }

  function fullscreen() {
    const el = boxRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen?.().catch(() => notify("tela cheia bloqueada", "err"));
    }
  }

  async function snapshot() {
    const img = imgRef.current;
    const raw = freezeRef.current;
    const source: CanvasImageSource | null = paused ? raw : img;
    const w = paused ? raw?.width ?? 0 : img?.naturalWidth ?? 0;
    const h = paused ? raw?.height ?? 0 : img?.naturalHeight ?? 0;
    if (!source || !w || !h) {
      notify("foto falhou — sem quadro ainda", "err");
      return;
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      drawFrame(ctx, source, w, h);
      const a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = `${slug(deviceName)}-${stamp(new Date())}.png`;
      a.click();
      notify("foto salva", "ok");
    } catch {
      notify("foto falhou — tente com o stream aberto", "err");
    }
  }

  function startRecording() {
    if (recording) return;
    if (paused) {
      notify("retome o vídeo para gravar", "err");
      return;
    }
    const img = imgRef.current;
    const canvas = captureRef.current;
    if (!img || !canvas || !img.naturalWidth) {
      notify("sem quadro para gravar ainda", "err");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      notify("gravação não suportada neste navegador", "err");
      return;
    }
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      notify("gravação falhou — canvas indisponível", "err");
      return;
    }

    if (clipUrlRef.current) {
      URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = null;
      setClip(null);
    }

    const opts: MediaRecorderOptions = { videoBitsPerSecond: VIDEO_BITRATE };
    if (recMime) opts.mimeType = recMime;
    let rec: MediaRecorder;
    try {
      // um stream por player, reaproveitado: recriar `captureStream` a cada
      // gravação deixaria trilhas vivas acumuladas (a 2ª gravação falhava)
      streamRef.current ??= canvas.captureStream(CAPTURE_FPS);
      rec = new MediaRecorder(streamRef.current, opts);
    } catch {
      notify("gravação não suportada neste navegador", "err");
      return;
    }

    chunksRef.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: rec.mimeType || "video/webm" });
      chunksRef.current = [];
      if (!aliveRef.current) return;
      if (!blob.size) {
        notify("gravação vazia — nada foi capturado", "err");
        return;
      }
      const url = URL.createObjectURL(blob);
      clipUrlRef.current = url;
      const name = `camera-${slug(deviceName)}-${stamp(new Date(startedAtRef.current))}.webm`;
      setClip({ url, name, size: blob.size });
      notify(`gravação pronta · ${(blob.size / 1e6).toFixed(1)} MB`, "ok");
    };

    try {
      drawFrame(ctx, img, canvas.width, canvas.height);
    } catch {
      notify("gravação falhou — quadro inválido", "err");
      return;
    }
    // ritmo fixo por timer: em aba de segundo plano o rAF para, o setInterval
    // (estrangulado) segue — o arquivo sai com menos fps, nunca vazio.
    drawTimerRef.current = setInterval(() => {
      const el = imgRef.current;
      if (!el?.naturalWidth) return;
      try {
        drawFrame(ctx, el, canvas.width, canvas.height);
      } catch {
        /* quadro ainda não decodificado: pula */
      }
    }, Math.round(1000 / CAPTURE_FPS));

    startedAtRef.current = Date.now();
    setRecSeconds(0);
    recTimerRef.current = setInterval(
      () => setRecSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)),
      500,
    );

    rec.start(1000);
    recorderRef.current = rec;
    setRecording(true);
    onRecordingChange(true);
  }

  function stopRecording() {
    const rec = recorderRef.current;
    if (!rec) return;
    if (drawTimerRef.current) {
      clearInterval(drawTimerRef.current);
      drawTimerRef.current = null;
    }
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current);
      recTimerRef.current = null;
    }
    recorderRef.current = null;
    setRecording(false);
    onRecordingChange(false);
    try {
      rec.stop();
    } catch {
      /* já parado */
    }
  }

  const showOverlay = !paused && streamState !== "live";
  const stateLabel = paused
    ? `pausado · ${frozenAt ?? "—"}`
    : recording
      ? "gravando"
      : streamState === "live"
        ? "ao vivo"
        : streamState === "error"
          ? "erro"
          : "conectando…";

  return (
    <div
      ref={boxRef}
      className="nebu-player group relative overflow-hidden rounded-xl border border-border/60 bg-black"
    >
      {/* filtro de temperatura: um só SVG serve a tela e o ctx.filter */}
      <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
        <defs>
          <filter id={filterId}>
            <feColorMatrix type="matrix" values={tempMatrix(adjust.temperature)} />
          </filter>
        </defs>
      </svg>

      {paused ? (
        /* pausa = quadro congelado; o ajuste é re-aplicado via ctx.filter */
        <canvas ref={frozenViewRef} className="nebu-frame block w-full" />
      ) : (
        <>
          {/* next/image não serve: é multipart/x-mixed-replace, não uma imagem */}
          {/* crossOrigin + CORS do backend: permite fotografar via canvas */}
          <img
            key={streamKey}
            ref={imgRef}
            crossOrigin="anonymous"
            src={src}
            alt="ao vivo"
            className="nebu-frame block w-full"
            style={{ filter: cssFilter }}
            onError={onImgBroken}
          />
          {/* canvas da gravação: precisa existir/pintar; invisível, não ocupa espaço */}
          <canvas
            ref={captureRef}
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0"
          />
        </>
      )}

      {showOverlay && (
        <div className="absolute inset-0 z-10 grid place-items-center gap-3 bg-background/85 text-center">
          {needsRelogin ? (
            <AlertTriangle className="size-6 text-amber-400" />
          ) : (
            <Loader2 className="size-6 animate-spin text-primary" />
          )}
          <p className="max-w-md px-6 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {overlayText}
          </p>
          {needsRelogin && (
            <div className="flex gap-2">
              <Button size="sm" onClick={onRetry}>
                <RefreshCw className="size-3.5" />
                Tentar de novo
              </Button>
            </div>
          )}
        </div>
      )}

      {/* barra de controles do player */}
      <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-3 pb-2 pt-8">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-white hover:bg-white/15 hover:text-white"
            title={paused ? "Retomar ao vivo" : recording ? "Pare a gravação primeiro" : "Pausar"}
            aria-label={paused ? "Retomar ao vivo" : "Pausar"}
            disabled={recording && !paused}
            onClick={() => (paused ? resume() : pause())}
          >
            {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
          </Button>

          <span
            className={`font-mono text-[11px] tabular-nums ${
              paused ? "text-amber-300" : "text-white/90"
            }`}
          >
            {stateLabel}
          </span>

          {recording && (
            <span className="ml-1 inline-flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-rose-300">
              <span className="size-2 animate-pulse rounded-full bg-rose-500" />
              REC {clock(recSeconds)}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              title="Foto (snapshot)"
              aria-label="Foto (snapshot)"
              disabled={Boolean(imgBroken) && !paused}
              onClick={snapshot}
            >
              <Camera className="size-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className={`size-8 hover:bg-white/15 ${
                recording ? "text-rose-400" : "text-white"
              }`}
              title={
                !recSupported
                  ? "Gravação não suportada neste navegador"
                  : recording
                    ? "Parar gravação"
                    : paused
                      ? "Retome o vídeo para gravar"
                      : "Gravar"
              }
              aria-label={recording ? "Parar gravação" : "Gravar"}
              disabled={!recSupported || (!recording && paused)}
              onClick={() => (recording ? stopRecording() : startRecording())}
            >
              {recording ? (
                <Square className="size-3.5 fill-current" />
              ) : (
                <Circle className="size-4 fill-rose-500 text-rose-500" />
              )}
            </Button>

            <div className="relative">
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-white hover:bg-white/15 hover:text-white"
                title="Ajustes de imagem"
                aria-label="Ajustes de imagem"
                aria-expanded={showAdjust}
                onClick={() => setShowAdjust((v) => !v)}
              >
                <SlidersHorizontal className="size-4" />
              </Button>
              {showAdjust && (
                <>
                  <button
                    type="button"
                    aria-label="fechar ajustes"
                    className="fixed inset-0 z-40 cursor-default"
                    onClick={() => setShowAdjust(false)}
                  />
                  <div
                    className="absolute bottom-full right-0 z-50 mb-2 w-64 rounded-xl border border-border/60 bg-popover p-3 text-popover-foreground shadow-2xl"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setShowAdjust(false);
                    }}
                  >
                    <AdjustRow
                      label="Brilho"
                      value={adjust.brightness}
                      min={50}
                      max={150}
                      onChange={(v) => setAdjust((a) => ({ ...a, brightness: v }))}
                    />
                    <AdjustRow
                      label="Contraste"
                      value={adjust.contrast}
                      min={50}
                      max={150}
                      onChange={(v) => setAdjust((a) => ({ ...a, contrast: v }))}
                    />
                    <AdjustRow
                      label="Saturação"
                      value={adjust.saturation}
                      min={0}
                      max={200}
                      onChange={(v) => setAdjust((a) => ({ ...a, saturation: v }))}
                    />
                    <AdjustRow
                      label="Temperatura"
                      value={adjust.temperature}
                      min={-100}
                      max={100}
                      signed
                      onChange={(v) => setAdjust((a) => ({ ...a, temperature: v }))}
                    />
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <p className="text-[10px] leading-snug text-muted-foreground">
                        Vale também para a foto e a gravação.
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 shrink-0 gap-1 px-2 text-[11px]"
                        disabled={isDefault}
                        onClick={() => setAdjust(DEFAULTS)}
                      >
                        <RotateCcw className="size-3" />
                        Restaurar
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-white hover:bg-white/15 hover:text-white"
              title={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
              aria-label={isFullscreen ? "Sair da tela cheia" : "Tela cheia"}
              onClick={fullscreen}
            >
              {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </Button>
          </div>
        </div>

        {clip && (
          <div className="mt-1.5 flex items-center gap-2 rounded-md bg-black/60 px-2 py-1 text-[11px] text-white/90">
            <Download className="size-3.5 text-emerald-300" />
            <a
              href={clip.url}
              download={clip.name}
              className="truncate font-mono underline-offset-2 hover:underline"
              title="baixar gravação"
            >
              {clip.name}
            </a>
            <span className="shrink-0 font-mono text-white/60">
              {clip.size < 1e6 ? `${(clip.size / 1e3).toFixed(0)} kB` : `${(clip.size / 1e6).toFixed(1)} MB`}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function AdjustRow({
  label,
  value,
  min,
  max,
  signed,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  signed?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="mb-2.5 space-y-1 last:mb-0">
      <div className="flex items-center justify-between text-[11px]">
        <span>{label}</span>
        <span className="font-mono text-muted-foreground">
          {signed && value > 0 ? `+${value}` : value}
          {signed ? "" : "%"}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={1}
        onValueChange={([v]) => onChange(v)}
      />
    </div>
  );
}
