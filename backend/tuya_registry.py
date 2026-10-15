"""
Descoberta de dispositivos — agora **sem estado**.

Antes esta lista vivia em `data/tuya_devices_cache.json`. Não mora mais em
lugar nenhum: o navegador manda as chaves no bundle a cada requisição e o
resultado é montado em memória, descartado no fim.

Fontes, por autoridade:

  1. NUVEM   `/v2.0/users/{uid}/devices` usando os cookies que vieram no
             bundle. Diz *quais* devices existem, nome, categoria, productId.
  2. LAN     varredura Tuya. Diz *quais* devices existem na rede, o *ip* e a
             versão de protocolo. A nuvem erra muito de IP (já devolveu
             203.0.113.12 para um device em 192.168.1.10 — IPs de exemplo),
             então a rede tem prioridade.
  3. CHAVES  localKey, vindas no bundle. A API web da Tuya não devolve a
             localKey — ela só existe no app. Device sem chave aparece como
             "sem chave" em vez de sumir.

O `kind` vem da categoria da nuvem; sem categoria, cai para
`data/type_hints.json` (opcional, fora do pacote) e por fim para as dicas
embutidas (`_DEFAULT_HINTS`) ou `cloud`. Um `kind` no bundle tem
precedência: é dado do dono, ajustável pela UI.
"""

from __future__ import annotations

import json
import threading
import time
import unicodedata
from pathlib import Path

import tuya_bundle

# ---------------------------------------------------------------------------
# Categoria Tuya -> tipo de controle que conseguimos fazer
# ---------------------------------------------------------------------------
CATEGORY_KIND = {
    "bj": "bulb", "bj_lr": "bulb", "bj_sa": "bulb", "bj_ri": "bulb",
    "dj": "bulb", "xdd": "bulb",
    "dd": "plug", "dd_cg": "plug", "pc": "plug", "zndb": "plug",
    "sp": "plug", "kg": "plug", "kg_zndb": "plug", "pc_zndb": "plug",
    "ddcr": "plug", "zndbj": "plug",
    "ipc": "cam",
    "infrared_tv": "ir", "infrared_ac": "ir", "infrared_stb": "ir",
    "infrared": "ir",
    "qt": "ir", "wk": "ir", "gyd": "ir",
}

# Produtos do catálogo Tuya (valem para qualquer conta que tenha o mesmo
# modelo). A nuvem web quase nunca devolve `category`, então o productId (que
# o gateway móvel devolve) é a fonte mais confiável de tipagem — vale mais que
# dica de nome. É só precisão extra: sem o produto na tabela, kind_for cai
# para categoria → dica de nome → "cloud".
PRODUCT_KIND = {
    "upayjgpozlnzlxaf": "plug",   # mini ventilador / tomada ventilador
    "krgeqnyljdcmalpo": "plug",   # mosquito cama/pc (interruptor on/off)
    "3vjxbqklw5vje1kc": "cam",    # SMBC1BS1 (câmera)
    "hgxexzlmz6mabiqx": "bulb",   # Lampada quarto/Steck (wf_ble_dj)
    "c09vejm6xa5fr8ek": "bulb",   # Lâmpada Banheiro/Quarto (wf_dj)
    "whs3cty93fzrqkpt": "ir",     # IR inteligente (ir_send = DP 201)
    "ocfmsqadzl05q0hu": "ir",     # Smart IR (DPs 1-13)
}

# As dicas de nome são só config de fallback e podem ficar em
# data/type_hints.json (fora do pacote versionado) para quem quiser ajustar
# sem editar código. O arquivo é OPCIONAL: sem ele, _DEFAULT_HINTS abaixo
# cobre tudo o que o arquivo do dono cobria.
ROOT = Path(__file__).resolve().parent
HINTS_FILE = ROOT.parent / "data" / "type_hints.json"

_DEFAULT_HINTS = (
    ("lamp", "bulb"), ("luz", "bulb"), ("lumin", "bulb"), ("abajur", "bulb"),
    ("spot", "bulb"), ("fita", "bulb"),
    ("tomada", "plug"), ("extens", "plug"), ("plug", "plug"),
    ("interrupt", "plug"), ("carregador", "plug"), ("filtro", "plug"),
    ("ventilador", "plug"), ("mosquito", "plug"),
    ("câmera", "cam"), ("camera", "cam"), ("infravermelho", "ir"),
)


def _fold(s: str) -> str:
    """minúsculas sem acento — 'Lâmpada' precisa casar com o hint 'lamp'."""
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def _hints() -> tuple:
    try:
        data = json.load(open(HINTS_FILE, encoding="utf-8"))
        return tuple((str(w), str(k)) for w, k in data["name_hints"])
    except (OSError, ValueError, KeyError, TypeError):
        return _DEFAULT_HINTS


def kind_for(category: str, name: str, product_id: str = "") -> str:
    c = (category or "").lower()
    if c in CATEGORY_KIND:
        return CATEGORY_KIND[c]
    pid = (product_id or "").lower()
    if pid in PRODUCT_KIND:
        return PRODUCT_KIND[pid]
    low = _fold(name)
    for word, kind in _hints():
        if word in low:
            return kind
    return "cloud"


def _looks_virtual(dev_id: str) -> bool:
    """Matter/ponte: ids que são literalmente um MAC (16 hex)."""
    return len(dev_id) == 16 and all(ch in "0123456789abcdefABCDEF" for ch in dev_id)


def _is_routable_lan(ip: str) -> bool:
    """
    Só interessa IP de LAN. A nuvem devolve IP público com frequência
    (ex.: 203.0.113.12 para devices que estão em 192.168.1.x — IPs de
    exemplo). Conectar num IP público trava o status por timeout.

    Em vez de listar prefixos "que já vimos", testamos de verdade se o
    endereço pertence a uma rede privada/local.
    """
    import ipaddress
    ip = (ip or "").strip()
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    # 100.64/10 é CGNAT: ipaddress não marca como privado, mas não é público
    if isinstance(addr, ipaddress.IPv4Address) and addr in ipaddress.ip_network("100.64.0.0/10"):
        return True
    return bool(
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local
        or addr.is_unspecified
    )


class Registry:
    """
    Guarda só o que é derivado da rede — nada pessoal, e some no restart.
    O segredo (chaves, sessão) nunca entra aqui: vem no bundle.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._lan: dict[str, dict] = {}   # gid -> {ip, version}
        self._cloud: dict = {}            # cache curto da lista da nuvem
        self._cloud_at = 0.0
        self._cloud_key = ""

    # -- LAN ---------------------------------------------------------------
    def lan(self) -> dict:
        with self._lock:
            return dict(self._lan)

    def set_lan(self, mapping: dict) -> None:
        with self._lock:
            self._lan = {k: v for k, v in mapping.items() if k}

    def last_scan(self) -> dict:
        with self._lock:
            return {k: dict(v) for k, v in self._lan.items()}

    # -- nuvem --------------------------------------------------------------
    def cloud_devices(self, bundle: dict, ttl: float = 20.0) -> list:
        """
        Lista da conta usando os cookies do bundle. Cache curtíssimo, só para
        não martelar a Tuya a cada card — e é memória, não disco.
        """
        cloud = bundle.get("cloud") or {}
        if not cloud.get("cookies") or not cloud.get("host"):
            return []
        ck = f"{cloud['host']}|{cloud.get('uid') or ''}|{len(cloud['cookies'])}"
        now = time.monotonic()
        with self._lock:
            if ck == self._cloud_key and now - self._cloud_at < ttl:
                return self._cloud
        try:
            import tuya_cloud
            sess = tuya_cloud.client_from_cookies(cloud["host"], cloud["cookies"])
            data = tuya_cloud.list_devices(sess, cloud["host"])
        except Exception:
            return []
        result = data.get("result") or [] if data.get("success") else []
        with self._lock:
            self._cloud, self._cloud_at, self._cloud_key = result, now, ck
        return result

    # -- montagem -----------------------------------------------------------
    def build(self, bundle: dict) -> list:
        """Lista unificada. Puramente derivado — nada é persistido."""
        vault = bundle.get("keys") or {}
        lan = self.lan()
        cloud = self.cloud_devices(bundle)
        cloud_session = bool((bundle.get("cloud") or {}).get("accessToken"))

        base: dict[str, dict] = {}
        for d in cloud:
            gid = str(d.get("id") or "")
            if gid:
                base[gid] = {
                    "name": d.get("name") or "",
                    "category": d.get("category") or "",
                    "productId": d.get("product_id") or "",
                    "cloud_ip": d.get("local_ip") or "",
                }
        source = "cloud" if cloud else ("chaves" if vault else "vazio")

        # device que tem chave mas não apareceu na nuvem continua visível.
        # Entrada sem chave e sem papel (resíduo de scan / IP solto) NÃO é
        # device: a existência mora no bundle do navegador, não na memória
        # deste processo — o scan só empresta IP/versão para quem já existe.
        for gid, v in vault.items():
            if v.get("localKey") or v.get("role"):
                base.setdefault(gid, {"name": "", "category": "",
                                      "productId": "", "cloud_ip": ""})

        devices = []
        for gid, info in base.items():
            v = vault.get(gid) or {}
            name = info["name"] or v.get("name") or gid
            kind = v.get("kind") or kind_for(
                info["category"] or v.get("category"), name,
                info["productId"] or v.get("productId"))
            if _looks_virtual(gid):
                kind = "cloud"

            lan_e = lan.get(gid) or {}
            ip = lan_e.get("ip") or v.get("ip") or info["cloud_ip"] or ""
            if not _is_routable_lan(ip):
                # IP público/estranho: sem controle local até o scan achar o
                # endereço certo. Nada de tentar conectar e esperar timeout.
                ip = ""
            ver = lan_e.get("version") or str(v.get("ver") or "")
            key = v.get("localKey") or None
            local = bool(key and ip and kind in ("bulb", "plug", "ir"))
            # Dá para comandar sem estar na mesma rede: é o gateway móvel que
            # relay o DPS, igual o app. Bulb/plug precisam da chave; o blaster
            # IR não — o DP publish pela nuvem só depende da sessão (o
            # `cloud_publish` nem usa localKey).
            remote = bool(cloud_session and (
                kind == "ir" or (key and kind in ("bulb", "plug"))))

            notes = []
            if kind == "cam":
                notes.append("vídeo via P2P — sem DPS de controle (abre no player)")
            elif kind == "ir":
                # o blaster não tem estado útil para sondar: ele emite.
                if not remote:
                    notes.append("precisa de sessão: o comando IR vai pela nuvem")
                elif not ip:
                    notes.append("comando pela nuvem (sem IP na LAN)")
            elif _looks_virtual(gid):
                notes.append("Matter/virtual — painel físico, não tem stream próprio")
            elif not key:
                if ip:
                    # achado no scan: a localKey só existe no app da Tuya.
                    # Fica visível e honesto — não controlável, mas não sumido
                    notes.append(f"achado na rede v{ver or '3.3'} · "
                                 "sem localKey: visível, não controlável")
                else:
                    notes.append("sem localKey carregado: só aparece na nuvem")
            elif not ip and remote:
                notes.append("fora da LAN — comando vai pela nuvem, como no app")
            elif not ip:
                notes.append("sem IP na LAN agora")
            elif not local and not remote and kind == "cloud":
                notes.append("sem controle para este tipo")

            devices.append({
                "id": gid, "name": name, "kind": kind,
                "category": info["category"], "productId": info["productId"],
                "ip": ip or None, "cloud_ip": info["cloud_ip"] or None,
                "key": key, "ver": ver or "3.3", "local": local,
                "remote": remote,
                "virtual": _looks_virtual(gid), "role": v.get("role") or None,
                "note": " · ".join(notes) if notes else None,
            })

        devices.sort(key=lambda d: (d["kind"] == "cam", d["name"].lower()))
        self._source = {
            "source": source,
            "lan_devices": len(lan),
            "bundle_keys": len(vault),
            "cloud": bool(cloud),
        }
        return devices

    def source(self, bundle: dict) -> dict:
        self.build(bundle)
        return dict(self._source)

    def by_role(self, bundle: dict, role: str):
        for d in self.build(bundle):
            if d.get("role") == role:
                return d
        return None

    def invalidate(self) -> None:
        """Descarta o cache curto da lista da nuvem."""
        with self._lock:
            self._cloud, self._cloud_at, self._cloud_key = [], 0.0, ""

    def new_keys(self, bundle: dict, seen: dict) -> list:
        """
        Devices vistos na LAN que ainda não têm chave no bundle.
        A UI usa isso para perguntar ao usuário se pode importar a chave.
        """
        vault = bundle.get("keys") or {}
        return [gid for gid in seen if gid not in vault]


REGISTRY = Registry()