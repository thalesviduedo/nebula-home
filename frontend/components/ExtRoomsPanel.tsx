"use client";

/**
 * CASAS / CÔMODOS / GRUPOS / MALHA — o mapa da conta.
 *
 * Três abas, três fontes diferentes do gateway móvel:
 *   - Casas: `m.life.home.space.list` + o cômodo de cada device
 *     (`m.life.my.group.device.sort.list` v2.1 + `m.life.group.room.map.get`)
 *   - Compartilhados: quem larga um aparelho na sua conta
 *     (`smartlife.m.my.shared.device.list` / `...device.group.list`)
 *   - Malha: gateway -> sub-dispositivo
 *     (`m.life.my.group.mesh.list` v3.1 + `...device.relation.list` v3.2)
 *
 * Tudo o que aparece aqui é o que a conta de verdade respondeu: id, nome e IP
 * são os da Tuya. Nada de chave, nada de chute.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes, ChevronDown, ChevronRight, DoorOpen, Home as HomeIcon, Loader2,
  Network, RefreshCw, Share2, TriangleAlert, Users,
} from "lucide-react";
import {
  extRooms, MESH_KIND, NO_ROOM,
  type Home, type MeshGateway, type MeshRelation, type Room, type RoomDevice,
} from "@/lib/ext/rooms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/* --------------------------------------------------------------- utilidades */

function useHomes() {
  return useQuery({
    queryKey: ["ext", "rooms", "homes"],
    queryFn: () => extRooms.homes(),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
}

function useShared() {
  return useQuery({
    queryKey: ["ext", "rooms", "shared"],
    queryFn: () => extRooms.shared(),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
}

function useMesh() {
  return useQuery({
    queryKey: ["ext", "rooms", "mesh"],
    queryFn: () => extRooms.mesh(),
    placeholderData: (prev) => prev,
    staleTime: 60_000,
  });
}

function Refresher({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={onClick}
      className="shrink-0"
    >
      {busy ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
      <span className="sr-only">Atualizar</span>
    </Button>
  );
}

/**
 * `?fresh=1` fura o cache curto do backend: o botão "atualizar" é uma
 * consulta de verdade, não a mesma resposta de 90 s atrás.
 */
function useFresh<T>(key: string[], fetcher: (fresh: boolean) => Promise<T>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => fetcher(true),
    onSuccess: (data) => qc.setQueryData(key, data),
  });
}

/** API que o gateway recusou — o erro literal do servidor, sem GoesAway. */
function Warnings({ warnings }: { warnings?: string[] }) {
  if (!warnings?.length) return null;
  return (
    <div className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-400/10 p-3">
      <p className="flex items-center gap-2 text-xs font-medium text-amber-300">
        <TriangleAlert className="size-3.5" />
        {warnings.length === 1
          ? "uma API recusou — o resto está normal"
          : `${warnings.length} APIs recusaram — o resto está normal`}
      </p>
      <ul className="space-y-0.5 font-mono text-[10px] leading-relaxed text-amber-200/80">
        {warnings.map((w) => (
          <li key={w}>· {w}</li>
        ))}
      </ul>
    </div>
  );
}

function ErrorBox({ error }: { error: Error | null }) {
  if (!error) return null;
  return (
    <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3">
      <p className="text-xs font-medium text-rose-300">não deu para ler</p>
      <p className="mt-1 font-mono text-[10px] leading-relaxed text-rose-200/80">
        {error.message}
      </p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-lg bg-secondary/40 px-3 py-4 text-center text-xs text-muted-foreground">
      {text}
    </p>
  );
}

/* ------------------------------------------------------------------ device -- */

function DeviceLine({ d }: { d: RoomDevice }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/50 bg-background/40 px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-xs font-medium">{d.name}</span>
          {d.virtual && (
            <Badge variant="outline" className="h-4 px-1.5 text-[9px]">
              virtual
            </Badge>
          )}
          {d.local && (
            <Badge variant="secondary" className="h-4 px-1.5 text-[9px]">
              com chave
            </Badge>
          )}
        </span>
        <span className="block truncate font-mono text-[10px] text-muted-foreground">
          {d.id}
          {d.ip ? ` · ${d.ip}` : " · sem IP"}
          {d.ver ? ` · fw ${d.ver}` : ""}
        </span>
      </span>
      <span
        className={`size-2 shrink-0 rounded-full ${
          d.online ? "bg-emerald-400" : "bg-border"
        }`}
        title={d.online ? "online na nuvem" : "offline"}
      />
    </li>
  );
}

function DeviceList({ devices }: { devices: RoomDevice[] }) {
  if (!devices.length) {
    return (
      <p className="px-1 py-2 text-[11px] text-muted-foreground">
        nenhum dispositivo neste cômodo
      </p>
    );
  }
  return (
    <ul className="space-y-1.5">
      {devices.map((d) => (
        <DeviceLine key={d.id} d={d} />
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------- cômodo */

function RoomBlock({ room }: { room: Room }) {
  const isNone = room.room_id === NO_ROOM;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <DoorOpen className="size-3.5 shrink-0 text-primary" />
        <p className="truncate text-sm font-semibold">
          {isNone ? "Sem cômodo" : room.name}
        </p>
        <Badge variant="outline" className="font-mono text-[10px]">
          {room.count}
        </Badge>
        {isNone && (
          <span className="truncate font-mono text-[10px] text-muted-foreground">
            roomId {NO_ROOM}
          </span>
        )}
        {room.tags.map((t) => (
          <Badge key={t} variant="secondary" className="text-[10px]">
            {t}
          </Badge>
        ))}
      </div>
      <DeviceList devices={room.devices} />
    </div>
  );
}

function HomeBlock({ home }: { home: Home }) {
  const [open, setOpen] = useState(true);
  return (
    <Card className="border-border/70 bg-card/60">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 items-center gap-2 text-left"
          >
            {open ? (
              <ChevronDown className="size-4 shrink-0 text-primary" />
            ) : (
              <ChevronRight className="size-4 shrink-0 text-primary" />
            )}
            <HomeIcon className="size-4 shrink-0 text-primary" />
            <span className="truncate text-base font-semibold">{home.name}</span>
          </button>
        </div>
        <CardDescription className="font-mono text-[11px]">
          gid {home.gid}
          {home.admin ? " · admin" : ""}
          {home.role != null ? ` · role ${home.role}` : ""}
        </CardDescription>
        <div className="flex flex-wrap gap-2 pt-1">
          <Badge variant="secondary">{home.count} dispositivos</Badge>
          <Badge variant="outline">{home.rooms_count} cômodos</Badge>
          {home.unassigned > 0 && (
            <Badge variant="outline">{home.unassigned} sem cômodo</Badge>
          )}
        </div>
      </CardHeader>
      {open && (
        <CardContent className="space-y-5">
          {home.rooms.length === 0 ? (
            <Empty text="A conta respondeu sem nenhum device nesta casa." />
          ) : (
            home.rooms.map((room, i) => (
              <div key={room.room_id}>
                {i > 0 && <Separator className="mb-5 bg-border/50" />}
                <RoomBlock room={room} />
              </div>
            ))
          )}
        </CardContent>
      )}
    </Card>
  );
}

function HomesTab() {
  const q = useHomes();
  const fresh = useFresh(["ext", "rooms", "homes"], extRooms.homes);
  if (q.isPending) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> lendo as casas na nuvem…
        </CardContent>
      </Card>
    );
  }
  const homes = q.data?.homes ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {homes.length} {homes.length === 1 ? "casa" : "casas"} ·{" "}
          {q.data?.cached ? "cache do backend" : "consultado agora"}
        </p>
        <Refresher
          busy={q.isFetching || fresh.isPending}
          onClick={() => fresh.mutate()}
        />
      </div>
      <ErrorBox error={q.error} />
      <Warnings warnings={q.data?.warnings} />
      {homes.length === 0 && !q.error ? (
        <Empty text="A conta não tem casa cadastrada no app." />
      ) : (
        homes.map((h) => <HomeBlock key={h.gid} home={h} />)
      )}
    </div>
  );
}

/* ---------------------------------------------------------- compartilhados -- */

function SharedTab() {
  const q = useShared();
  const fresh = useFresh(["ext", "rooms", "shared"], extRooms.shared);
  const devices = q.data?.devices ?? [];
  const groups = q.data?.groups ?? [];

  if (q.isPending) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> procurando o que é seu…
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {devices.length} {devices.length === 1 ? "aparelho" : "aparelhos"} ·{" "}
          {groups.length} {groups.length === 1 ? "grupo" : "grupos"}
        </p>
        <Refresher
          busy={q.isFetching || fresh.isPending}
          onClick={() => fresh.mutate()}
        />
      </div>
      <ErrorBox error={q.error} />
      <Warnings warnings={q.data?.warnings} />

      {devices.length === 0 && groups.length === 0 ? (
        <Empty text="Ninguém compartilhou nada com esta conta — a lista veio vazia da Tuya." />
      ) : (
        <>
          {devices.length > 0 && (
            <Card className="border-border/70 bg-card/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Share2 className="size-4 text-primary" />
                  Dispositivos compartilhados
                </CardTitle>
              </CardHeader>
              <CardContent>
                <DeviceList devices={devices} />
              </CardContent>
            </Card>
          )}
          {groups.length > 0 && (
            <Card className="border-border/70 bg-card/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Users className="size-4 text-primary" />
                  Grupos compartilhados
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {groups.map((g) => (
                  <div
                    key={g.id}
                    className="rounded-md border border-border/50 bg-background/40 px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      <p className="truncate text-xs font-medium">{g.name}</p>
                      <Badge variant="outline" className="font-mono text-[10px]">
                        {g.count}
                      </Badge>
                    </div>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">
                      {g.id}
                      {g.room_name ? ` · ${g.room_name}` : ""}
                    </p>
                    {g.device_ids.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {g.device_ids.map((id) => (
                          <li
                            key={id}
                            className="font-mono text-[10px] text-muted-foreground/80"
                          >
                            · {id}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- malha */

/** Arrays vazios estáveis: um `?? []` por render quebra o memo do `orphans`. */
const NO_GATEWAYS: MeshGateway[] = [];
const NO_RELATIONS: MeshRelation[] = [];

function GatewayBlock({ gw }: { gw: MeshGateway }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="truncate text-sm font-semibold">{gw.name}</p>
        <Badge variant="secondary" className="text-[10px]">
          {MESH_KIND[gw.kind] ?? gw.kind}
        </Badge>
        {gw.has_key && (
          <Badge variant="outline" className="text-[10px]">
            com chave
          </Badge>
        )}
        {gw.ip && (
          <span className="font-mono text-[10px] text-muted-foreground">
            {gw.ip}
          </span>
        )}
      </div>
      <p className="font-mono text-[10px] text-muted-foreground">
        {gw.id}
        {gw.code && gw.code !== gw.id ? ` · code ${gw.code}` : ""}
        {gw.pv ? ` · pv ${gw.pv}` : ""}
        {gw.type != null ? ` · tipo ${gw.type}` : ""}
      </p>
      {gw.child_ids.length === 0 ? (
        <p className="px-1 text-[11px] text-muted-foreground">
          sem sub-dispositivos nesta conta
        </p>
      ) : (
        <ul className="space-y-1">
          {gw.child_ids.map((id) => (
            <li
              key={id}
              className="rounded-md border border-border/50 bg-background/40 px-3 py-2 font-mono text-[11px]"
            >
              <span className="text-muted-foreground">sub · </span>
              {id}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MeshTab() {
  const q = useMesh();
  const fresh = useFresh(["ext", "rooms", "mesh"], extRooms.mesh);
  const gateways = q.data?.gateways ?? NO_GATEWAYS;
  const relations = q.data?.relations ?? NO_RELATIONS;
  const orphans = useMemo(
    () => relations.filter((r) => !gateways.some((g) => g.id === r.parent_id)),
    [relations, gateways],
  );

  if (q.isPending) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> procurando bridges e módulos…
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {gateways.length} {gateways.length === 1 ? "gateway" : "gateways"} ·{" "}
          {relations.length}{" "}
          {relations.length === 1 ? "sub-dispositivo" : "sub-dispositivos"}
        </p>
        <Refresher
          busy={q.isFetching || fresh.isPending}
          onClick={() => fresh.mutate()}
        />
      </div>
      <ErrorBox error={q.error} />
      <Warnings warnings={q.data?.warnings} />

      {gateways.length === 0 && relations.length === 0 ? (
        <Empty text="Esta conta não tem malha — nenhum bridge registrado." />
      ) : (
        <>
          {gateways.length > 0 && (
            <Card className="border-border/70 bg-card/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Network className="size-4 text-primary" />
                  Gateways de malha
                </CardTitle>
                <CardDescription className="text-xs">
                  A chave da malha existe no gateway e não sai do backend.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {gateways.map((gw, i) => (
                  <div key={gw.id}>
                    {i > 0 && <Separator className="mb-5 bg-border/50" />}
                    <GatewayBlock gw={gw} />
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {relations.length > 0 && (
            <Card className="border-border/70 bg-card/60">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Boxes className="size-4 text-primary" />
                  Sub-dispositivos (pai → filho)
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1.5">
                  {relations.map((r) => (
                    <li
                      key={`${r.parent_id}:${r.child_id}`}
                      className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-background/40 px-3 py-2 font-mono text-[11px]"
                    >
                      <span className="truncate">{r.parent_name}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="truncate">{r.child_name}</span>
                      {orphans.some((o) => o.child_id === r.child_id) && (
                        <Badge variant="outline" className="text-[9px]">
                          pai fora da malha
                        </Badge>
                      )}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- painel */

export default function ExtRoomsPanel() {
  const [tab, setTab] = useState("homes");
  return (
    <Card className="border-primary/15 bg-card/60 backdrop-blur">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <HomeIcon className="size-4 text-primary" />
          Casas, cômodos e malha
        </CardTitle>
        <CardDescription className="text-xs">
          Onde cada aparelho mora, o que outra pessoa compartilhou com a conta e
          quais bridges têm módulos pendurados.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="homes" className="gap-1.5">
              <HomeIcon className="size-3.5" /> Casas
            </TabsTrigger>
            <TabsTrigger value="shared" className="gap-1.5">
              <Share2 className="size-3.5" /> Compartilhados
            </TabsTrigger>
            <TabsTrigger value="mesh" className="gap-1.5">
              <Network className="size-3.5" /> Malha
            </TabsTrigger>
          </TabsList>
          <TabsContent value="homes" className="mt-4">
            <HomesTab />
          </TabsContent>
          <TabsContent value="shared" className="mt-4">
            <SharedTab />
          </TabsContent>
          <TabsContent value="mesh" className="mt-4">
            <MeshTab />
          </TabsContent>
        </Tabs>
      </CardContent>

      <CardFooter className="border-t border-border/50 px-6 py-2.5">
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          m.life.home.space.list · group.room.map.get · device.sort.list · mesh.list
        </span>
      </CardFooter>
    </Card>
  );
}