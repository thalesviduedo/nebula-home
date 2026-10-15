"use client";

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download, KeyRound, Lock, LogIn, LogOut, Radio, ShieldCheck, Trash2, Upload,
} from "lucide-react";
import { api } from "@/lib/api";
import {
  bundleSummary, clearBundle, exportBundle, getBundle, importBundle,
  mergeKeys, serverBundle, setCloud, setIr, subscribe, type DeviceKey,
} from "@/lib/bundle";
import { useNotify } from "@/lib/query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfig } from "@/hooks/useConfig";

const PILL =
  "flex items-center gap-2 rounded-lg bg-surface-container-low px-3 py-1.5 text-[12px]";

export default function CloudCard() {
  const notify = useNotify();
  const qc = useQueryClient();
  const { data: cfg } = useConfig();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // QR removido do front: o login por QR entrega sessão PARCIAL (só cookies,
  // sem accessToken) — sem ele não há controle remoto, IR na nuvem nem o
  // MQTT que alimenta a câmera. Serve só para listar aparelhos. Ficou só
  // e-mail e senha; os endpoints /api/cloud/qr* seguem no backend.

  // Bundle é estado externo (localStorage): useSyncExternalStore entrega o
  // valor do servidor na hidratação e o real logo depois, sem mismatch.
  const bundle = useSyncExternalStore(subscribe, getBundle, serverBundle);
  const summary = bundleSummary(bundle);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data, isPending, refetch } = useQuery({
    queryKey: ["cloud"],
    queryFn: () => api.cloudStatus(),
    refetchInterval: 5000,
    placeholderData: (prev) => prev,
  });

  const refreshAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["cloud"] });
    qc.invalidateQueries({ queryKey: ["devices"] });
    // o TvRemote lê /api/ir/buttons com staleTime de 60s: sem invalidar aqui,
    // o autoIr baixava as keys mas o card continuava dizendo "sem códigos".
    qc.invalidateQueries({ queryKey: ["ir-buttons"] });
  }, [qc]);

  // Keys IR aprendidas vivem na nuvem da Tuya (record.get -> keydata.get).
  // Não precisa mais importar arquivo: baixamos direto pro navegador.
  const irCloud = useMutation({
    mutationFn: (learned: boolean) => api.irCloudKeys(learned ? { learned: true } : {}),
    onSuccess: (r) => {
      if (!r.ok || !r.ir) {
        notify(`keys IR: ${r.error ?? "falhou"}`, "err");
        return;
      }
      setIr(r.ir as Parameters<typeof setIr>[0]);
      const n = Object.keys(r.ir.keys ?? {}).length;
      const extra = r.learned_count ? ` + ${r.learned_count} aprendidos` : "";
      notify(
        `${n} keys IR baixadas da nuvem (${r.brandName ?? "marca?"}${extra})`,
        "ok",
      );
      refreshAll();
    },
    onError: () => notify("não consegui falar com a nuvem", "err"),
  });

  // Baixa as keys IR da nuvem sozinho depois do login (os controles virtuais
  // da conta não aparecem na lista de devices; sem isso o controle da TV
  // ficava "sem códigos" até importar arquivo). Best-effort e silencioso:
  // conta sem controle virtual ou sessão parcial (QR) simplesmente não faz nada.
  const autoIr = useCallback(async () => {
    try {
      const r = await api.irCloudKeys();
      if (r.ok && r.ir && Object.keys(r.ir.keys ?? {}).length) {
        setIr(r.ir as Parameters<typeof setIr>[0]);
        const n = Object.keys(r.ir.keys).length;
        const extra = r.learned_count ? ` + ${r.learned_count} aprendidos` : "";
        notify(`keys IR da nuvem: ${n}${extra} (${r.brandName ?? "controle"})`, "ok");
        refreshAll();
      }
    } catch {
      // silencioso de propósito: não é erro de login
    }
  }, [notify, refreshAll]);

  const login = useMutation({
    mutationFn: () => api.login({ email, password, country: cfg?.country, region: cfg?.region }),
    onSuccess: (r) => {
      setPassword("");
      if (r.ok && r.cloud) {
        setCloud(r.cloud);
        const n = Object.keys(r.keys ?? {}).length;
        if (n) {
          // a API web entregou as chaves: os dispositivos entram sozinhos
          mergeKeys(r.keys as Record<string, DeviceKey>);
          notify(`conta ${r.cloud.email} · ${n} dispositivos prontos`, "ok");
        } else {
          notify(r.warning ?? `conta ${r.cloud.email} guardada no navegador`, "ok");
        }
        refreshAll();
        void autoIr();
      } else {
        notify(r.error ?? "login falhou", "err");
      }
    },
    onError: (e) => notify(`login falhou: ${e.message}`, "err"),
  });

  const logout = useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      setCloud(null);
      notify("conta removida do navegador", "ok");
      refreshAll();
    },
  });

  const loggedIn = Boolean(data?.logged_in);
  const session = data?.sessions?.[0];

  const doExport = () => {
    const blob = new Blob([exportBundle()], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nebula-bundle.txt";
    a.click();
    URL.revokeObjectURL(a.href);
    notify("bundle exportado — guarde esse arquivo", "ok");
  };

  const doImport = (file: File) => {
    const fr = new FileReader();
    fr.onload = () => {
      try {
        importBundle(String(fr.result));
        notify("bundle importado", "ok");
        refreshAll();
      } catch (e) {
        notify(`arquivo inválido: ${e}`, "err");
      }
    };
    fr.readAsText(file);
  };

  return (
    <section className="relative flex flex-col gap-4 overflow-hidden rounded-xl bg-surface-container/70 p-5 shadow-xl backdrop-blur-xl">
      <div className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-primary/10 blur-3xl" />

      {/* cabeçalho de sessão */}
      <div className="relative z-10 flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2.5">
            {loggedIn ? (
              <ShieldCheck className="size-6 text-mint" />
            ) : (
              <LogIn className="size-6 text-primary" />
            )}
            <span className="text-[20px] text-on-surface">
              {loggedIn
                ? "Conta Tuya Conectada & Cofre Criptográfico"
                : "Conectar conta Tuya"}
            </span>
            <span
              className={`flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-[11px] ${
                loggedIn
                  ? "bg-secondary-container/30 text-mint"
                  : "bg-surface-container-high text-on-surface-variant"
              }`}
            >
              {loggedIn && <span className="size-1.5 animate-pulse rounded-full bg-mint" />}
              {loggedIn ? "Sessão Local Ativa" : "Sem sessão"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-on-surface-variant">
            {loggedIn ? (
              <>
                <span className="font-mono text-on-surface">{session?.email}</span>
                <span className="text-outline-variant">•</span>
                <span className="font-mono text-[11px] text-outline">UID: {session?.uid}</span>
                <span className="text-outline-variant">•</span>
                <span>{session?.cookies} cookies no navegador</span>
                <span className="text-outline-variant">•</span>
                <span>
                  região:{" "}
                  <span className="font-mono text-on-surface">{session?.host ?? cfg?.region}</span>
                </span>
                <span className="text-outline-variant">•</span>
                <span className="text-primary">
                  {data?.rtsp?.sources?.length ?? 0} câmera(s) publicada(s)
                </span>
              </>
            ) : (
              <span>
                login com e-mail e senha · região{" "}
                <span className="font-mono text-on-surface">{cfg?.region ?? "us-west"}</span> ·
                a sessão fica só no seu navegador
              </span>
            )}
          </div>
        </div>

        {loggedIn && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => refetch()}
              className="flex items-center gap-2 rounded-lg bg-surface-container-high px-3 py-1.5 text-[12px] text-on-surface-variant transition-all hover:bg-surface-bright hover:text-on-surface"
            >
              <ShieldCheck className="size-4 text-primary" />
              {isPending ? "verificando…" : "Reverificar Sessão"}
            </button>
            <button
              type="button"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
              className="flex items-center gap-2 rounded-lg bg-error-container/30 px-3 py-1.5 text-[12px] text-error transition-all hover:bg-error-container/50 disabled:opacity-60"
            >
              <LogOut className="size-4" />
              Remover do Navegador
            </button>
          </div>
        )}
      </div>

      {/* login (quando sem sessão) */}
      {!loggedIn && (
        <div className="relative z-10 flex flex-col gap-3 rounded-xl bg-surface-container-lowest/90 p-4">
          <div className="grid items-end gap-3 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="email" className="text-[11px] text-on-surface-variant">
                E-mail
              </Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                placeholder="voce@exemplo.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9 border-outline-variant/40 bg-surface-container-high"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password" className="text-[11px] text-on-surface-variant">
                Senha
              </Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && email && password) login.mutate();
                }}
                className="h-9 border-outline-variant/40 bg-surface-container-high"
              />
            </div>
            <Button
              size="default"
              className="h-9 w-full rounded-xl"
              disabled={login.isPending || !email || !password}
              onClick={() => login.mutate()}
            >
              <LogIn className="size-3.5" />
              {login.isPending ? "Entrando…" : "Entrar"}
            </Button>
          </div>
          <p className="text-[10px] leading-relaxed text-outline">
            a senha vai só ao backend local, é usada para o md5 com a chave RSA
            da Tuya e nunca é gravada
          </p>
        </div>
      )}

      {/* métricas do cofre */}
      <div className="relative z-10 flex flex-wrap items-center gap-2">
        <div className={PILL}>
          <KeyRound className="size-4 text-primary" />
          <span className="text-on-surface-variant">Chaves:</span>
          <span className="font-mono font-semibold text-primary">{summary.keys} AES-128</span>
        </div>
        <div className={PILL}>
          <Radio className="size-4 text-mint" />
          <span className="text-on-surface-variant">RTSP local:</span>
          <span className="font-mono text-[11px] text-mint">
            {data?.rtsp?.base ?? cfg?.rtsp_base ?? "—"}
          </span>
        </div>
        <div className={PILL}>
          <Radio className="size-4 text-tertiary" />
          <span className="text-on-surface-variant">Base IR:</span>
          <span className="font-mono text-tertiary">{summary.ir} comandos</span>
        </div>
        <div className={PILL}>
          <Lock className="size-4 text-outline" />
          <span className="text-outline">Storage: somente o navegador</span>
        </div>
      </div>

      {/* aviso: sessão sem chaves */}
      {loggedIn && summary.keys === 0 && (
        <div className="relative z-10 rounded-xl border border-tertiary/30 bg-tertiary-container/10 p-3.5">
          <p className="text-xs font-medium text-tertiary">
            Conta conectada, mas sem as chaves dos aparelhos
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-on-surface-variant">
            A Tuya não devolve a chave local pela API — ela só existe dentro do
            app. Sem ela o backend sabe <b className="text-on-surface">quais</b>{" "}
            aparelhos existem, mas não consegue comandar nenhum. Importe um
            bundle com as chaves ou rode <code className="mx-1 text-primary">LAN Discovery</code>{" "}
            para o painel encontrar os IPs.
          </p>
        </div>
      )}

      {/* deck de ações do cofre */}
      <div className="relative z-10 flex flex-col justify-between gap-4 rounded-xl bg-surface-container-lowest/90 p-4 shadow-inner lg:flex-row lg:items-center">
        <div className="flex max-w-xl flex-col gap-1">
          <div className="flex items-center gap-2 text-on-surface">
            <Lock className="size-4 text-primary" />
            <span className="text-[15px] font-semibold">Backup do Cofre</span>
          </div>
          <p className="text-[11px] leading-relaxed text-on-surface-variant">
            O backend não armazena nada. Ao limpar os dados do navegador ou
            trocar de dispositivo, exporte este arquivo para recuperar as chaves
            e a sessão.
          </p>
          <p className="font-mono text-[10px] text-outline">
            {summary.keys} chaves · {summary.cloud ?? "sem conta"} · {summary.ir} códigos IR
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={doExport}
            className="flex items-center gap-2 rounded-lg bg-surface-container-high px-3.5 py-2 text-[12px] text-on-surface shadow-sm transition-all hover:bg-surface-bright"
          >
            <Download className="size-4 text-primary" />
            Exportar Backup
          </button>
          <button
            type="button"
            disabled={irCloud.isPending}
            onClick={() => irCloud.mutate(false)}
            className="flex items-center gap-2 rounded-lg bg-surface-container-high px-3.5 py-2 text-[12px] text-on-surface shadow-sm transition-all hover:bg-surface-bright disabled:opacity-60"
          >
            <Radio className="size-4 text-tertiary" />
            {irCloud.isPending ? "baixando…" : "Keys IR Nuvem"}
          </button>
          <button
            type="button"
            disabled={irCloud.isPending}
            onClick={() => irCloud.mutate(true)}
            className="flex items-center gap-2 rounded-lg bg-surface-container-high px-3.5 py-2 text-[12px] text-on-surface shadow-sm transition-all hover:bg-surface-bright disabled:opacity-60"
          >
            <Radio className="size-4 text-mint" />
            Keys IR + Aprendidas
          </button>
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="flex items-center gap-2 rounded-lg bg-surface-container-high px-3.5 py-2 text-[12px] text-on-surface shadow-sm transition-all hover:bg-surface-bright"
          >
            <Upload className="size-4 text-primary" />
            Importar
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".txt,text/plain"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImport(f);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => {
              clearBundle();
              notify("bundle apagado do navegador", "ok");
              refreshAll();
            }}
            className="flex items-center gap-2 rounded-lg bg-error-container px-3.5 py-2 text-[12px] font-medium text-on-error-container shadow-md transition-all hover:brightness-125"
          >
            <Trash2 className="size-4" />
            Apagar Tudo
          </button>
        </div>
      </div>
    </section>
  );
}
