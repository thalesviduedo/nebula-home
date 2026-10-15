"use client";

/**
 * O que este painel guarda no navegador — e só isto.
 *
 * A arquitetura é "backend sem estado": as localKey, os cookies da conta e os
 * códigos IR vivem aqui e viajam no header `X-Nebula-Bundle` a cada
 * requisição. O servidor não guarda nada em disco.
 *
 * Tudo fora da chave do bundle é bloqueado: nada de device, token ou
 * preferência fica espalhado pelo storage.
 *
 * A API do backend não devolve segredo e a sessão Tuya mora no servidor, em
 * `data/`. Se nada for gravado no cliente, trocar de navegador — ou abrir o
 * projeto num PC de outra pessoa — não mostra nada seu nem nada de quem opened
 * antes. Sem sessão, sem cookie, sem device em cache.
 *
 * Isto:
 *   1. limpa qualquer resíduo de versões antigas (localStorage, sessionStorage,
 *      cookies, IndexedDB, Cache Storage);
 *   2. bloqueia novas escritas, para uma lib futura não recriar o problema.
 *
 * O React Query já é só em memória (nenhum plugin de persistência instalado).
 */

const REPORT = "[nebula] ";

const KEEP = "nebula.bundle.v1"; // única chave preservada

function wipeStorage() {
  try {
    for (const k of Object.keys(localStorage)) {
      if (k !== KEEP) localStorage.removeItem(k);
    }
  } catch {
    /* storage indisponível (modo privado) — tudo bem */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* idem */
  }
  if (typeof document !== "undefined") {
    for (const c of document.cookie.split(";")) {
      const name = c.split("=")[0]?.trim();
      if (!name) continue;
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  }
}

async function wipeIdbAndCaches() {
  try {
    if (typeof indexedDB !== "undefined" && indexedDB.databases) {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs
          .filter((d) => d.name)
          .map(
            (d) =>
              new Promise<void>((res) => {
                const req = indexedDB.deleteDatabase(d.name!);
                req.onsuccess = req.onerror = req.onblocked = () => res();
              }),
          ),
      );
    }
  } catch {
    /* idem */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* idem */
  }
}

/**
 * Intercepta as escritas e as descarta. Não é só aviso: a gravação é
 * bloqueada de fato, senão uma lib futura recriaria o vazamento em silêncio.
 */
function blockWrites() {
  if (typeof Storage === "undefined") return;
  for (const proto of [localStorage, sessionStorage]) {
    for (const prop of ["setItem", "removeItem", "clear"] as const) {
      const original = proto[prop] as unknown as (...a: unknown[]) => void;
      Object.defineProperty(proto, prop, {
        configurable: true,
        value: function (this: Storage, ...args: unknown[]) {
          // a chave do bundle é o único storage legítimo do painel
          if (prop === "setItem" && args[0] === KEEP) {
            return original.apply(this, args);
          }
          console.warn(
            `${REPORT}bloqueado: ${prop}(${String(args[0])}) — o painel só guarda "${KEEP}"`,
          );
          // sem `original.apply(...)`: a escrita não acontece
        },
      });
    }
  }
}

let done = false;

export function enforceNoBrowserPersistence() {
  if (done || typeof window === "undefined") return;
  done = true;
  wipeStorage();
  void wipeIdbAndCaches();
  blockWrites();
}