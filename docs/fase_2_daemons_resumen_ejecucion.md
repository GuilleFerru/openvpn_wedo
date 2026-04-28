# Resumen de ejecución — Plan dos daemons OpenVPN (UG63v2 + futuros 2.5+)

**Fechas de ejecución:** 2026-04-23 a 2026-04-28
**Branch:** `feat/second-daemon-ug63`
**Plan original:** [`plan_2_daemons_ug63.md`](./plan_2_daemons_ug63.md)
**Estado final:** Fase 1, 2 y 3 completas (con simplificación en Fase 3 + bugs fixados durante implementación).

---

## 1. Qué se ejecutó del plan

### Fase 1 — Infra de dos daemons (plan §10 Fase 1)

| Tarea del plan | Estado | Notas |
|---|---|---|
| Branch `feat/second-daemon-ug63` | OK | |
| Regla GCP firewall 1195/udp | OK | `infra/firewall.tf` — `vpn_udp_modern` (nombre `vpn-prod-fw-vpn-modern`, consistente con scheme existente vs. `vpn-prod-fw-openvpn-modern` propuesto en plan §9.1) |
| `docker-compose.yml` con `network_mode: host` para ambos daemons | OK | Removido pipeline de iptables inline (vivía en el container `openvpn`). Removido `ports`, `sysctls`. |
| Container `openvpn-modern` agregado | OK | Misma imagen kylemanna, mismo volumen PKI compartido, port 1195, tun1, CCD bind a `./ccd-modern` |
| `openvpn-admin` `depends_on: openvpn-modern` | OK | |
| Script `infra/scripts/openvpn-iptables.sh` | OK | Chain custom `OPENVPN_FWD` con 1024 reglas: conntrack + admin + same-group classic + same-group modern + cross-daemon same-group + DROP final |
| `systemd` unit `openvpn-iptables.service` para persistir reboots | OK | Instalada via `startup.sh`, `enabled` |
| `infra/scripts/startup.sh` extendido | OK | ufw 1195, mkdir ccd-modern + chown, symlink, gen `openvpn-modern.conf` via cp+sed (NO `ovpn_genconfig` — ver §13.3 plan), invoca iptables script |
| Routes cross-subnet en configs | OK con cambio | Solo `push "route ..."` — el `route ...` bare causa rutas duplicadas en host (ver §3 bugs) |

### Fase 2 — Admin panel aware (plan §10 Fase 2)

| Tarea del plan | Estado |
|---|---|
| `admin/config.py`: `DAEMON_CONFIG`, `MODEL_TO_DAEMON`, `DEFAULT_MODEL`, `CCD_DIR_MODERN` | OK |
| Migración silenciosa `clients.json` v1→v2 | OK (mejorada) — detecta daemon por CCD existente, no asume todo `classic`. WILO se auto-migra a `daemon=modern, ip=10.9.8.1` |
| `admin/network.py` daemon-aware (`group_client_to_ip(group, num, daemon)`) | OK |
| `admin/vpn.py` daemon-aware CCD + ovpn export | OK — `_export_ovpn_config(name, daemon)` patches port y agrega `ignore-unknown-option comp-lzo` + `allow-compression yes` para modern |
| `admin/blueprints/clients.py`: `create` recibe `model`, `connected` lee ambos daemons | OK |
| `admin/blueprints/groups.py`: per-daemon counts + ranges | OK (no estaba en plan original — agregado por feedback "grupos mixtos") |
| `docker-compose.yml` bind `./ccd-modern:/app/ccd-modern` en admin | OK |
| Migración auto-corrige IP de WILO si CCD modern dice otra cosa que la DB | OK |
| Dropdown "Modelo" en form de alta + hint dinámico daemon | OK |
| Columna "Daemon" en tabla "Conexiones activas" | OK |
| Badge `[modelo]` + `[daemon]` en lista "Clientes por grupo" | OK |
| 4to stat card "Modern / Total" | OK (no en plan — agregado por UX) |
| CSS: `.badge-classic`, `.badge-modern`, `.stat-card.mint` | OK |
| Edit cliente con confirmación cambio modelo (plan §8.4.3) | NO — UI de edit cliente no existe hoy. Pospuesto. |

### Fase 3 — Migración WILO (plan §10 Fase 3)

**Ejecutada en versión simplificada** (sin Fase 2). Cuando se hizo Fase 3, Fase 2 todavía no existía. Pasos manuales en VM:

1. `cp /opt/vpn/clients/035-1-GW002.ovpn 035-1-GW002-daemon2.ovpn`
2. `sed` port 1194→1195 en la copia
3. CCD manual `/mnt/vpn-data/ccd-modern/035-1-GW002` con `ifconfig-push 10.9.8.1 255.255.0.0`
4. `.ovpn` subido al UG63 desde la UI Milesight
5. WILO conectó a daemon2 IP `10.9.8.1`, ping 100%, UI accesible

Posteriormente (durante Fase 2) hubo que **reparar mismatch** entre filename y CN (ver §3 bugs).

---

## 2. Tests cumplidos (plan §11)

### Fase 1 (§11.1) — todos verdes excepto group isolation cross-group

| Test | Resultado |
|---|---|
| daemon1 + daemon2 `Initialization Sequence Completed` | OK |
| 7 UG67 + admin desktops conectados | OK |
| Ping host → UG67 (4 IPs) 100% | OK |
| WILO en daemon2 status | OK |
| Ping host → 10.9.8.1 — sostenido 60/60 100% | OK |
| `Bad compression stub` daemon2 = 0 | OK |
| `OPENVPN_FWD` enganchada + 1024 rules | OK |
| 5 containers UP (admin/traefik/proxy/openvpn/openvpn-modern) | OK |
| Cross-daemon (admin desktop → 10.9.8.1) | OK (browser login UG63 funciona) |
| Group isolation cross-group (UG67 grupo A → UG67 grupo B) | NO TESTEADO directamente. Lógica idéntica a chain anterior; aceptable. |

### Fase 3 (§11.3)

| Test | Resultado |
|---|---|
| WILO connected estable >5min | OK (2h+ uptime sin reconnect loop) |
| `http://10.9.8.1` desde admin desktop | OK |
| Ping sostenido daemon2 5min | OK 100% |
| Logs daemon2 sin `Bad compression` | OK |

---

## 3. Bugs encontrados durante ejecución y fixes aplicados

### 3.1 `terraform apply` quería **reemplazar la VM**

`google_compute_instance.metadata_startup_script` tiene `ForceNew` en el provider GCP. Cualquier edit a `infra/scripts/startup.sh` disparaba destrucción + recreación de la VM (downtime 10-20min). Además el alias `ubuntu-2204-lts` resuelve a versiones distintas → drift permanente.

**Fix:** `lifecycle ignore_changes` en `infra/compute.tf`:
```hcl
lifecycle {
  ignore_changes = [
    metadata_startup_script,
    boot_disk[0].initialize_params[0].image,
  ]
}
```
**Tradeoff aceptado:** cambios futuros a `startup.sh` no se propagan via terraform — aplicar manual via SSH (que es el flujo real de todas formas). Para forzar re-bootstrap, `terraform taint` + `apply`.

### 3.2 WILO entry perdida en `clients.json` post-Fase 2

Durante Fase 3 simplificada, el `.ovpn` se nombró `035-1-GW002-daemon2.ovpn` (nombre distinto al CN del cert). El admin lista clientes por nombre de archivo → al rebuild Fase 2, no había `035-1-GW002.ovpn` y la entry de DB se perdió. Stat row mostraba 0/16 con WILO realmente conectado en daemon2 con IP 10.9.8.1.

**Fix manual aplicado en VM:**
1. `mv 035-1-GW002-daemon2.ovpn → 035-1-GW002.ovpn` (alinea con CN)
2. Re-agregar entry en `clients.json` con `{group: wilo, ip: 10.9.8.1, model: UG63v2, daemon: modern}`
3. Bump `wilo.next_client_modern = 2`

**Lección:** futuras migraciones manuales que generen .ovpn deben **mantener filename == CN** o adaptar la lógica de listado del admin.

### 3.3 Revoke vía SIGHUP tumbó ambos daemons

`reload_all_daemons` original (plan §8.3.3) usaba `docker kill -s HUP`. Pero kylemanna's `ovpn_run` hace drop de privilegios a `nobody`. El SIGHUP causa process re-exec, y el proceso re-exec'd corre como `nobody` → no puede leer `/etc/openvpn/pki/private/` ni `crl.pem` ni `dh.pem` → daemon termina con errores `Options error: ... Permission denied (errno=13)` y queda down.

**Fix en `admin/vpn.py`:** `reload_all_daemons` ahora usa `docker restart <container>` en vez de SIGHUP. Downtime ~5s por daemon, reconexión automática. Trade off acceptable porque revoke es operación rara.

**Recovery del incidente:** `docker restart openvpn openvpn-modern` los recuperó.

### 3.4 Bare `route 10.X.0.0` en configs causa rutas host duplicadas

Plan §3.2 proponía `route 10.9.0.0 255.255.0.0` + `push "route 10.9.0.0 255.255.0.0"` en `openvpn.conf` de daemon1 (y simétrico en daemon2). Funcionaba al inicio, pero después de un restart de daemons quedó:

```
10.9.0.0/16 via 10.8.0.2 dev tun0     ← user-space del bare route, gana
10.9.0.0/16 dev tun1 proto kernel ... ← kernel auto del server line
```

El kernel elegía la primera y los pings a 10.9.8.1 desde el host salían por tun0 → silencio.

**Fix en `infra/scripts/startup.sh` y configs en VM:** mantener solo `push "route ..."` (push al cliente), eliminar el bare `route ...`. La kernel route auto-creada por la directiva `server X.X/16` es suficiente para el host.

### 3.5 Cert WILO accidentalmente revocado

Durante prueba de UI Fase 2, el cert de `035-1-GW002` fue movido a la CRL. WILO no podía reconectar (`VERIFY ERROR: certificate revoked`).

**Procedure de unrevoke aplicada (no merge a main, solo emergencia):**
1. Backup `index.txt`
2. `mv pki/revoked/certs_by_serial/<SERIAL>.crt → pki/issued/<CN>.crt` (idem `.key` desde `private_by_serial`)
3. Editar `index.txt`: línea con `R\t<expiry>\t<revdate>\t<serial>...` → `V\t<expiry>\t\t<serial>...`
4. `easyrsa gen-crl` + copy a `/etc/openvpn/crl.pem`
5. `docker restart` ambos daemons

WILO reconectó OK. Posteriormente el user **renombró** `035-1-GW002` → `035-2-GW001` (revoke + create nuevo, vía UI ya con fix de §3.3 deployado).

---

## 4. Estado final del sistema

### 4.1 Infraestructura

- **2 daemons** corriendo en host networking, mismo volumen PKI:
  - `openvpn` — UDP 1194, subnet `10.8.0.0/16`, tun0, comp-lzo on
  - `openvpn-modern` — UDP 1195, subnet `10.9.0.0/16`, tun1, sin comp-lzo
- **`OPENVPN_FWD` chain** en host (1024 reglas) gestiona aislamiento por grupo y cross-daemon. `systemd` unit la persiste entre reboots.
- **GCP firewall**: 1194/udp + 1195/udp + 80/tcp + 443/tcp + IAP-SSH.
- **Disco persistente** `vpn-prod-data` con `prevent_destroy = true`. PKI, clients, CCDs sobreviven destrucción de VM.
- **VM con `lifecycle ignore_changes`** — futuros edits a `startup.sh` no recreán la VM.

### 4.2 Admin panel

- Migración auto v1→v2 al boot (idempotente).
- Crear cliente: dropdown modelo (UG67/UG65/UG56/UG63v2/Desktop/Otro) → derivación automática de daemon → IP en subnet correcta → CCD en dir correcto → `.ovpn` con port correcto.
- Lista de conexiones unifica ambos daemons con badge `[classic]` o `[modern]`.
- Lista por grupo muestra badges `[modelo]` + `[daemon]` por cliente.
- Stat row con 4 cards (incluyendo `Modern / Total`).
- Revoke usa `docker restart` ambos daemons (no SIGHUP).
- Grupos mixtos (clientes classic + modern en mismo grupo) soportados con contadores independientes y rendering breakdown.

### 4.3 Clientes en producción (al cierre de la conversación)

| Tipo | Cantidad | Daemon |
|---|---|---|
| Gateways UG67 / UG56 / UG65 | ~14 en grupos varios | classic (10.8/16) |
| Desktops admin (`Guille-Admin*`, `Ivo-Admin`) | 3 | classic |
| UG63v2 (WILO renombrado a `035-2-GW001`) | 1 | modern (10.9.8.2) |

---

## 5. Archivos modificados / creados

| Archivo | Cambio |
|---|---|
| `infra/firewall.tf` | + regla `vpn_udp_modern` 1195/udp |
| `infra/compute.tf` | + `lifecycle ignore_changes` (startup_script, boot image) |
| `infra/scripts/startup.sh` | + ufw 1195, ccd-modern, gen openvpn-modern.conf, push routes (NO bare), invoke iptables, systemd unit |
| `infra/scripts/openvpn-iptables.sh` | NUEVO — chain `OPENVPN_FWD` idempotente |
| `docker-compose.yml` | host networking ambos openvpn, nuevo container openvpn-modern, admin bind ccd-modern |
| `admin/config.py` | + `DAEMON_CONFIG`, `MODEL_TO_DAEMON`, `DEFAULT_MODEL`, `CCD_DIR_MODERN` |
| `admin/db.py` | + migración v2 con detección por CCD, contadores per-daemon, refactor `recalculate` |
| `admin/network.py` | API daemon-aware + `ip_to_daemon` helper |
| `admin/vpn.py` | CCD/ovpn por daemon, `reload_all_daemons` con docker restart |
| `admin/blueprints/clients.py` | create recibe model, connected/rejected leen ambos daemons |
| `admin/blueprints/groups.py` | per-daemon counts + ranges (classic/modern) |
| `admin/templates/index.html` | dropdown Modelo + hint, columna Daemon, 4to stat card |
| `admin/static/js/app.js` | render badges, hint dinámico, ratio modern, breakdown grupo mixto |
| `admin/static/css/style.css` | `.badge-classic`, `.badge-modern`, `.badge-model`, `.stat-card.mint` |
| `docs/plan_2_daemons_ug63.md` | actualizado §12.1 con rollback detallado + nota sobre `terraform apply` no replace |

---

## 6. Pendientes opcionales

- **Edit cliente UI** (plan §8.4.3) — no implementado. Permitiría cambiar modelo de un cliente existente con confirmación de revoke + reissue. No urgente.
- **Group isolation test cross-group** — no validado directamente (requiere SSH a un UG67 para disparar ping a otro grupo). La chain replica idénticamente la lógica anterior; riesgo residual bajo.
- **Limpieza de `.bak-phase1`** en VM — los backups (`/tmp/iptables-pre-phase1.rules`, `/mnt/vpn-data/openvpn/openvpn.conf.bak-phase1`, `/opt/vpn/docker-compose.yml.bak-phase1`) pueden borrarse pasados unos días.
- **Merge a `master`** — branch `feat/second-daemon-ug63` aún sin merge. Esperar uno o dos días más de operación estable y mergear.
- **Limpieza CCD viejo en `/ccd/035-1-GW002`** — ya no existe (revoke lo borró), pero la entry `wilo.next_client = 2` quedó como histórico. No afecta operación.
- **Recompactación de contadores** — `wilo.next_client_modern = 4` por intentos previos durante migración. Próximo modern client en wilo arrancará en `.4` saltando huecos. Trivial: `POST /api/recalculate` lo recompacta a 3.
- **Feature `alias` por cliente** (sugerido por user para renames cosméticos sin re-issue) — no implementado, queda como propuesta documentada en conversación.

---

## 7. Procedure de rollback

Documentado en `plan_2_daemons_ug63.md` §12.1 (actualizado durante esta conversación con prerequisitos de backup, comandos exactos y tabla de casos).

Resumen TL;DR: `docker compose down` → desenganchar `OPENVPN_FWD` y restaurar `iptables-save` previo → deshabilitar systemd unit → `git checkout master` → restaurar `openvpn.conf` desde backup → `docker compose up -d`. Downtime ~3-5min.

---

## 8. Lecciones técnicas

1. **`metadata_startup_script` de GCP es `ForceNew`** — siempre usar `lifecycle ignore_changes` en VMs en producción para evitar replace accidental.
2. **kylemanna/openvpn no maneja SIGHUP correctamente** — drop privs + re-exec rompe lectura de PKI privado. Usar `docker restart` para reload de CRL.
3. **`route X.X.X.X netmask` bare en configs server con host networking causa rutas host duplicadas.** Usar solo `push "route ..."` para anunciar al cliente; el server ya tiene la kernel route por la directiva `server`.
4. **PKI compartida entre daemons funciona** sin races porque admin panel es el único escritor (Flask sync, una request a la vez).
5. **Migración con detección por filesystem (CCD existente)** es más robusta que asumir defaults — atrapa casos como WILO que fue migrado manualmente fuera del admin panel.
6. **Filename del `.ovpn` debe coincidir con CN** del cert si el admin lista clientes por filename. Evita mismatches al rebuild.
