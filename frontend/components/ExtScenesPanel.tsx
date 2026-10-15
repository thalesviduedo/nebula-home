"use client";

/**
 * Painel de CENAS, AUTOMAÇÕES, REGRAS DE LUZ e GEOFFENCE.
 *
 * Tudo que aparece aqui veio do gateway móvel da Tuya pela mesma rota assinada
 * que o app usa — os tipos em `lib/ext/scenes.ts` espelham a resposta real,
 * medida ao vivo. Duas coisas o painel NÃO finge:
 *
 *   - o caminho de leitura do gateway devolve as condições (gatilho/horário) mas
 *     descarta `actions`, então a lista de dispositivos acionados aparece vazia
 *     quando a Tuya não a manda;
 *   - geofence e "não perturbe" responderam `[]` nesta conta, e o painel mostra
 *     estado vazio em vez de inventar cerca.
 *
 * O botão Executar não é decorativo: ele chama `thing.m.linkage.rule.trigger`,
 * a mesma API que o app usa no botão da home, e mostra o retorno real do
 * gateway — inclusive o `PERMISSION_DENIED` quando a cena não existe.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlarmClock, BellOff, Clock, Info, Lightbulb, ListChecks, Loader2, MapPin,
  Play, Power, RefreshCw, ShieldCheck, Target, TriangleAlert,
} from "lucide-react";

import {
  extScenes, GENRE_LABEL, scheduleLabel,
  type Rule, type RuleCondition,
} from "@/lib/ext/scenes";
import { useNotify } from "@/lib/query";
import { getBundle } from "@/lib/bundle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";

/* -------------------------------------------------------------------- peças */

function Warnings({ list }: { list: string[] }) {
  if (!list.length) return null;
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-400/10 p-3">
      <p className="flex items-center gap-1.5 text-xs font-medium text-amber-300">
        <TriangleAlert className="size-3.5" />
        {list.length} API{list.length > 1 ? "s" : ""} recusou
      </p>
      <ul className="mt-1.5 space-y-0.5 font-mono text-[10px] leading-relaxed text-amber-200/80">
        {list.map((w) => (
          <li key={w}>· {w}</li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg border border-dashed border-border/70 bg-background/30 px-3 py-6 text-center text-xs text-muted-foreground">
      {text}
    </p>
  );
}

function ConditionLine({ cond }: { cond: RuleCondition }) {
  return (
    <li className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
      <Clock className="size-3 shrink-0 opacity-70" />
      <span className="truncate">{cond.label || cond.entity_id || cond.kind}</span>
    </li>
  );
}

function RuleRow({ rule, onRun, running }: {
  rule: Rule;
  onRun: (r: Rule) => void;
  running: boolean;
}) {
  const days = rule.schedule ? scheduleLabel(rule.schedule.days) : "";
  return (
    <li
      className={`rounded-lg border p-3 transition-colors ${
        rule.enabled
          ? "border-primary/20 bg-background/40"
          : "border-border/50 bg-background/20"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {rule.icon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={rule.icon} alt="" className="size-4 object-contain" />
            ) : null}
            <span className="truncate text-sm font-medium">{rule.name}</span>
            <Badge variant={rule.enabled ? "default" : "outline"} className="text-[10px]">
              {rule.enabled ? "ligada" : "desligada"}
            </Badge>
            {rule.alarm && (
              <Badge variant="secondary" className="text-[10px]">
                <AlarmClock className="size-3" /> alarme
              </Badge>
            )}
          </div>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
            {rule.id}
          </p>
        </div>

        <Button
          size="sm"
          variant={rule.enabled ? "default" : "outline"}
          disabled={running}
          onClick={() => onRun(rule)}
          title={`Executar ${rule.name}`}
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Play className="size-3.5" />
          )}
          Executar
        </Button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Badge variant="secondary" className="text-[10px] font-normal">
          {GENRE_LABEL[rule.genre ?? 1] ?? `genre ${rule.genre}`}
        </Badge>
        {rule.schedule?.time && (
          <Badge variant="outline" className="text-[10px] font-normal">
            <Clock className="size-3" />
            {rule.schedule.time}
            {days ? ` · ${days}` : ""}
          </Badge>
        )}
        {rule.rooms.length > 0 && (
          <Badge variant="outline" className="text-[10px] font-normal">
            {rule.rooms.length} cômodo{rule.rooms.length > 1 ? "s" : ""}
          </Badge>
        )}
      </div>

      {rule.conditions.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {rule.conditions.map((c) => (
            <ConditionLine key={`${c.entity_id}-${c.order}`} cond={c} />
          ))}
        </ul>
      )}

      {rule.actions.length > 0 && (
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/80">
          ações:{" "}
          {rule.actions
            .map((a) => `${a.label}${a.detail ? ` ${a.detail}` : ""}`)
            .join(" · ")}
        </p>
      )}

      {rule.devices.length > 0 ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          aciona: {rule.device_names.join(", ")}
        </p>
      ) : (
        <p className="mt-2 flex items-start gap-1 text-[10px] leading-relaxed text-muted-foreground/70">
          <Info className="mt-px size-3 shrink-0" />
          o gateway não devolve as ações desta regra na leitura — só o app, que
          as guarda no banco local depois de ler
        </p>
      )}
    </li>
  );
}

/* ------------------------------------------------------------------- painel */

export default function ExtScenesPanel() {
  const notify = useNotify();
  const qc = useQueryClient();
  const [fresh, setFresh] = useState(false);
  const hasCloud = Boolean(getBundle().cloud);

  const scenes = useQuery({
    queryKey: ["ext-scenes", "list", fresh],
    queryFn: () => extScenes.list(fresh),
    enabled: hasCloud,
    placeholderData: (prev) => prev,
  });
  const lights = useQuery({
    queryKey: ["ext-scenes", "lights", fresh],
    queryFn: () => extScenes.lights(fresh),
    enabled: hasCloud,
    placeholderData: (prev) => prev,
  });
  const fence = useQuery({
    queryKey: ["ext-scenes", "geofence", fresh],
    queryFn: () => extScenes.geofence(fresh),
    enabled: hasCloud,
    placeholderData: (prev) => prev,
  });

  const run = useMutation({
    mutationFn: (id: string) => extScenes.run(id),
    onSuccess: (r) => {
      notify(
        r.triggered
          ? `cena disparada · o gateway respondeu result: true`
          : `o gateway recusou: ${JSON.stringify(r.result)}`,
        r.triggered ? "ok" : "err",
      );
      qc.invalidateQueries({ queryKey: ["ext-scenes"] });
    },
    onError: (e) => notify(`não disparou: ${e.message}`, "err"),
  });

  const rules = scenes.data?.rules ?? [];
  const grouped = useMemo(
    () => ({
      scene: rules.filter((r) => r.kind === "scene"),
      automation: rules.filter((r) => r.kind === "automation"),
    }),
    [rules],
  );

  const reload = () => {
    setFresh(true);
    qc.invalidateQueries({ queryKey: ["ext-scenes"] });
    setTimeout(() => setFresh(false), 50);
  };

  const busy = scenes.isPending || lights.isPending || fence.isPending;
  const totals = [
    `${grouped.scene.length} cena(s)`,
    `${grouped.automation.length} automação(ões)`,
    `${scenes.data?.enabled ?? 0} ligada(s)`,
  ].join(" · ");

  return (
    <Card className="border-primary/15 bg-card/60 backdrop-blur">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks className="size-4 text-primary" />
              Cenas, automações, luz e geofence
            </CardTitle>
            <CardDescription className="text-xs">
              {hasCloud
                ? "gateway móvel da Tuya · mesma API do app Tuya Smart"
                : "conecte a conta em Nuvem para ler as cenas"}
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={!hasCloud || busy}
            onClick={reload}
          >
            <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
            recarregar
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!hasCloud ? (
          <Empty text="Sem sessão no bundle: nada aqui é lido da nuvem." />
        ) : (
          <Tabs defaultValue="cenas">
            <TabsList className="grid w-full grid-cols-3">
              <TabsTrigger value="cenas" className="gap-1.5">
                <Play className="size-3.5" /> Cenas
              </TabsTrigger>
              <TabsTrigger value="luz" className="gap-1.5">
                <Lightbulb className="size-3.5" /> Luz
              </TabsTrigger>
              <TabsTrigger value="geo" className="gap-1.5">
                <MapPin className="size-3.5" /> Geofence
              </TabsTrigger>
            </TabsList>

            {/* ------------------------------------------------------- cenas */}
            <TabsContent value="cenas" className="mt-4 space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="font-mono text-[10px]">
                  {totals}
                </Badge>
                {scenes.data?.gid && (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    gid {scenes.data.gid}
                  </Badge>
                )}
                {scenes.data?.counts?.scene_limit ? (
                  <Badge variant="outline" className="font-mono text-[10px]">
                    limite {scenes.data.counts.scene_limit} cenas /{" "}
                    {scenes.data.counts.automation_limit ?? 0} automações
                  </Badge>
                ) : null}
              </div>

              <Warnings list={scenes.data?.warnings ?? []} />

              {(["scene", "automation"] as const).map((kind) => (
                <section key={kind} className="space-y-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    {kind === "scene" ? (
                      <Play className="size-3.5" />
                    ) : (
                      <AlarmClock className="size-3.5" />
                    )}
                    {kind === "scene" ? "Cenas manuais" : "Automações"}
                  </h3>
                  {grouped[kind].length === 0 ? (
                    <Empty
                      text={
                        scenes.isPending
                          ? "lendo…"
                          : kind === "scene"
                            ? "nenhuma cena manual nesta casa"
                            : "nenhuma automação com gatilho nesta casa"
                      }
                    />
                  ) : (
                    <ul className="space-y-2">
                      {grouped[kind].map((r) => (
                        <RuleRow
                          key={r.id}
                          rule={r}
                          running={run.isPending && run.variables === r.id}
                          onRun={(x) => run.mutate(x.id)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              ))}

              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                Executar usa{" "}
                <code className="text-cyan-300">thing.m.linkage.rule.trigger</code>{" "}
                v1.0 — a mesma API do app no botão da home. O botão mostra o que o
                gateway devolveu, inclusive a recusa{" "}
                <code className="text-cyan-300">PERMISSION_DENIED</code> para uma
                cena que não existe.
              </p>
            </TabsContent>

            {/* -------------------------------------------------------- luz */}
            <TabsContent value="luz" className="mt-4 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <Badge
                  variant={lights.data?.preset_creatable ? "default" : "outline"}
                >
                  {lights.data?.preset_creatable
                    ? "pode criar preset de luz"
                    : "sem preset de luz nesta conta"}
                </Badge>
                <Badge variant="secondary">
                  {lights.data?.counts?.linkage ?? 0} regra(s) de luz
                </Badge>
              </div>

              <Warnings list={lights.data?.warnings ?? []} />

              {lights.isPending ? (
                <Empty text="lendo…" />
              ) : (lights.data?.linkage.length ?? 0) === 0 ? (
                <Empty text="smartlife.m.linkage.light.list respondeu vazio: nenhuma regra de iluminação criada pelo app Light." />
              ) : (
                <ul className="space-y-2">
                  {lights.data!.linkage.map((l) => (
                    <li
                      key={l.id}
                      className="rounded-lg border border-border/50 bg-background/30 p-3"
                    >
                      <p className="text-sm font-medium">{l.name}</p>
                      <p className="font-mono text-[10px] text-muted-foreground/70">
                        {l.id}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <p className="text-[10px] leading-relaxed text-muted-foreground/70">
                As cenas de luz que o app cria ficam no banco local dele: o
                caminho aberto de leitura é{" "}
                <code className="text-cyan-300">m.light.rule.query</code>, que com
                esta sessão devolve{" "}
                <code className="text-cyan-300">
                  REMOTE_API_PARAM_ALL_INPUT_LOSS
                </code>{" "}
                em toda payload. As regras que existem e são legíveis aparecem na
                aba Cenas.
              </p>
            </TabsContent>

            {/* -------------------------------------------------- geofence */}
            <TabsContent value="geo" className="mt-4 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary">
                  <Target className="size-3" />
                  {fence.data?.counts?.fences ?? 0} cerca(s)
                </Badge>
                <Badge variant="secondary">
                  {fence.data?.counts?.device_fences ?? 0} cerca(s) por aparelho
                </Badge>
                <Badge variant="secondary">
                  <BellOff className="size-3" />
                  {fence.data?.counts?.nodisturb ?? 0} não perturbe
                </Badge>
              </div>

              <Warnings list={fence.data?.warnings ?? []} />

              <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <MapPin className="size-3.5 text-primary" />
                  {fence.data?.home?.name ?? "casa"}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                  {fence.data?.home?.lat ?? "—"} ,{" "}
                  {fence.data?.home?.lon ?? "—"}
                  {fence.data?.home?.geo_name
                    ? ` · ${fence.data.home.geo_name}`
                    : " · endereço não salvo no app"}
                </p>
                <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
                  m.life.location.get v3.4
                </p>
              </div>

              {(fence.data?.fences.length ?? 0) === 0 &&
              (fence.data?.device_fences.length ?? 0) === 0 ? (
                <Empty text="smartlife.m.linkage.fence.query v2.0 e geofence.list.by.uid v1.0 responderam []: nenhuma cerca configurada. Crie uma no app (Alarme → Geofence) e ela aparece aqui." />
              ) : (
                <ul className="space-y-2">
                  {fence.data?.fences.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-lg border border-border/50 bg-background/30 p-3 text-xs"
                    >
                      <span className="font-medium">{f.name}</span>
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                        {f.id}
                      </span>
                    </li>
                  ))}
                  {fence.data?.device_fences.map((f) => (
                    <li
                      key={f.device_id ?? f.id}
                      className="rounded-lg border border-border/50 bg-background/30 p-3 text-xs"
                    >
                      <ShieldCheck className="mr-1.5 inline size-3.5" />
                      {f.device_name ?? f.device_id} · {f.name}
                    </li>
                  ))}
                </ul>
              )}

              {(fence.data?.nodisturb.length ?? 0) > 0 && (
                <ul className="space-y-1">
                  {fence.data?.nodisturb.map((n) => (
                    <li key={n.id} className="text-[11px] text-muted-foreground">
                      <BellOff className="mr-1.5 inline size-3" />
                      {n.device_name ?? n.dev_id ?? "conta"} · {n.start} → {n.end}
                    </li>
                  ))}
                </ul>
              )}

              <p className="flex items-start gap-1 text-[10px] leading-relaxed text-muted-foreground/70">
                <Power className="mt-px size-3 shrink-0" />
                Entrada e saída de casa aparecem como condição das automações (aba
                Cenas): o app{" "}
                <code className="text-cyan-300">smartlife.m.linkage.fence.query</code>{" "}
                é quem devolve as cercas, e nesta conta vieram vazias.
              </p>
            </TabsContent>
          </Tabs>
        )}
      </CardContent>
    </Card>
  );
}