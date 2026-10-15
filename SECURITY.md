# Security Policy

PoC local: backend sem estado, segredos vivem no navegador (`nebula.bundle.v1`)
e trafegam por `X-Nebula-Bundle` apenas para `127.0.0.1`.

## O que nunca commitar

- `localKey`, cookies de sessão (`sid`, `s-sid`), `accessToken`/`ecode`
- backups exportados do cofre (`nebula-bundle*.txt`, `*.localKey`)
- `.tuya-data/`, `data/`, `research/`, `scripts/` (já ignorados pelo `.gitignore`)

## Se vazar uma `localKey`

1. No app Tuya Smart, remova e readicione o dispositivo (rotaciona a chave).
2. Apague o backup exportado e limpe o cofre no painel (Inventário).
3. Reimporte só as chaves novas.

Senha Tuya nunca é gravada (md5 + RSA em memória, só no backend local).

## Reportar vulnerabilidade

Abra uma issue privada ou contate o dono do repo. Não poste `localKey`,
e-mail da conta ou dumps de `X-Nebula-Bundle` em issues públicas.
