# Auditoría de Infraestructura GCP — Post-deploy OpenVPN

**Fecha del deploy:** 2026-04-13
**Proyecto:** `integracion-tagoio`
**Estado:** ✅ DEPLOYADO Y FUNCIONANDO (pendiente solo DNS)

---

## 1. Resumen del estado actual

### Recursos GCP creados por Terraform (15 total)

| Recurso | Nombre | Detalle |
|---------|--------|---------|
| VPC | `vpn-prod-vpc` | Custom-mode, aislada de `tb-prod-vpc` |
| Subnet | `vpn-prod-subnet` | `10.30.1.0/24` en us-central1 |
| Cloud Router | `vpn-prod-router` | us-central1 |
| Cloud NAT | `vpn-prod-nat` | AUTO_ONLY, logging ERRORS_ONLY |
| Firewall (UDP) | `vpn-prod-fw-vpn` | UDP 1194 ← 0.0.0.0/0 → tag `vpn-prod-app` |
| Firewall (HTTPS) | `vpn-prod-fw-https` | TCP 80, 443 ← 0.0.0.0/0 → tag `vpn-prod-app` |
| Firewall (SSH) | `vpn-prod-fw-iap-ssh` | TCP 22 ← 35.235.240.0/20 → tag `vpn-prod-iap-ssh` |
| IP estática | `vpn-prod-static-ip` | **`34.44.29.193`** (regional EXTERNAL) |
| Disco persistente | `vpn-prod-data` | 10 GB pd-balanced, **`prevent_destroy = true`** |
| VM | `vpn-prod-vm` | e2-small, Ubuntu 22.04, boot 20 GB, IP interna `10.30.1.2` |
| Service Account | `vpn-prod-sa` | 2 roles proyecto + 1 bucket |
| IAM | `roles/logging.logWriter` | → `vpn-prod-sa` |
| IAM | `roles/monitoring.metricWriter` | → `vpn-prod-sa` |
| IAM (bucket) | `roles/storage.objectAdmin` | → `vpn-prod-sa` (solo en bucket nuevo) |
| Bucket GCS | `integracion-tagoio-vpn-prod-backups` | US-CENTRAL1, versionado, lifecycle 90 días |

### Estado de los 4 contenedores en la VM

| Container | Imagen | Estado | Puertos | Rol |
|-----------|--------|--------|---------|-----|
| `openvpn` | kylemanna/openvpn | Up | `0.0.0.0:1194/udp` | Servidor VPN |
| `openvpn-admin` | vpn-openvpn-admin (build local) | Up (healthy) | `8080/tcp` (interno) | Panel Flask/Gunicorn |
| `docker-socket-proxy` | tecnativa/docker-socket-proxy | Up | `2375/tcp` (interno) | Filtrado al Docker socket |
| `traefik` | traefik:v3.4 | Up | `0.0.0.0:80, 443` | Reverse proxy HTTPS + Let's Encrypt |

### PKI OpenVPN

- Ubicada en `/mnt/vpn-data/openvpn/pki/` (disco persistente)
- `ca.crt`, `ca.key`, cert del server (`34.44.29.193.crt`), `dh.pem`, `ta.key`, `crl.pem`
- Marker `.initialized` en `/mnt/vpn-data/` para idempotencia

### Firewall OS (ufw)

```
22/tcp   ALLOW IN  Anywhere
80/tcp   ALLOW IN  Anywhere
443/tcp  ALLOW IN  Anywhere
1194/udp ALLOW IN  Anywhere
```

Segunda capa (la primera es el firewall de GCP).

### Backup diario

- Cron: `/etc/cron.d/vpn-backup` → 02:00 UTC
- Script: `/opt/vpn/backup.sh` exporta PKI + `clients.json` + `ccd/` y sube a `gs://integracion-tagoio-vpn-prod-backups/`

---

## 2. Comparación con el estado de ThingsBoard

Se verificó que **no hay conflictos ni puntos de contacto** entre ambas infraestructuras:

| Aspecto | ThingsBoard (`tb-prod-*`) | OpenVPN (`vpn-prod-*`) | Compartido |
|---------|--------------------------|------------------------|------------|
| VPC | `tb-prod-vpc` (10.20.0.0/20) | `vpn-prod-vpc` (10.30.1.0/24) | ❌ NO (sin peering) |
| Subnet CIDR | `10.20.1.0/24` | `10.30.1.0/24` | ❌ NO (sin overlap) |
| Service Account | `tb-prod-sa` | `vpn-prod-sa` | ❌ NO |
| Firewall rules | 5 reglas `tb-prod-fw-*` + 2 externas | 3 reglas `vpn-prod-fw-*` | ❌ NO (por VPC) |
| IP estática | LB global 34.160.1.110, ChirpStack 34.44.235.226 | `34.44.29.193` | ❌ NO |
| Cloud SQL | `tb-prod-pg` (10.91.0.3) | No usa DB externa | ❌ NO |
| Cloud Router | `tb-prod-router` | `vpn-prod-router` | ❌ NO |
| Estado TF | `gs://tfstate-thingsboard-prod` | `gs://tfstate-vpn-prod` | ❌ NO |
| Bucket storage | `*-tb-prod-scripts`, `*-tb-prod-maintenance` | `*-vpn-prod-backups` | ❌ NO |
| Proyecto GCP | `integracion-tagoio` | `integracion-tagoio` | ✅ SÍ (inevitable) |
| Billing | Mismo | Mismo | ✅ SÍ (inevitable) |

> **El único acoplamiento es el proyecto GCP y el billing.** Cero rutas de red, cero credenciales compartidas, cero dependencias de servicios.

---

## 3. Problemas encontrados durante el deploy y resolución

### 3.1 ❌ Startup script falló al generar la CA de OpenVPN

**Error observado:**
```
Easy-RSA error: Failed to build the CA
Common Name (eg: your user, host, or server name) [Easy-RSA CA]:problems making Certificate Request
```

**Causa raíz:** En modo non-TTY (startup script de GCE), `easyrsa build-ca` bloquea esperando input interactivo para el Common Name. `nopass` solo cubre el passphrase, no el CN.

**Fix aplicado:**

```bash
docker compose run --rm \
  -e EASYRSA_BATCH=1 \
  -e EASYRSA_REQ_CN="OpenVPN-CA" \
  openvpn ovpn_initpki nopass
```

**Aplicado en:**
- ✅ VM actual (manualmente, PKI limpiada y regenerada)
- ✅ `infra/scripts/startup.sh` (para futuras recreaciones)

### 3.2 ❌ Traefik no podía leer la Docker API

**Error observado:**
```
Failed to retrieve information of the docker client and server host
error="Error response from daemon: client version 1.24 is too old.
Minimum supported API version is 1.44"
```

**Causa raíz:** Ubuntu 22.04 en este momento shipea `docker.io` **v29.1.3** (inusualmente nuevo), que rechaza requests con URLs `/v1.24/*`. Traefik (probado v3.3, v3.4, v3.5) **hardcodea `/v1.24/` en sus llamadas a la Docker API** — bug conocido en todas las versiones 3.x del Docker provider.

Se verificó con `curl --unix-socket /var/run/docker.sock`:
- `GET /v1.24/version` → **400** `client version 1.24 is too old`
- `GET /v1.44/version` → **200** OK
- `GET /version` (sin versión) → **200** OK

La env var `DOCKER_API_VERSION=1.44` **no ayuda** porque Traefik no usa `NewClientFromEnv()`.

**Fix aplicado:** Cambiar Traefik del **Docker provider** al **file provider**. Los routes se declaran estáticamente en `traefik-dynamic.yml` y no se toca la Docker API en absoluto.

Cambios:
- `traefik-dynamic.yml` (nuevo archivo en la raíz del repo)
- `docker-compose.yml`:
  - Removidas las `labels` de `openvpn-admin`
  - Traefik pasa a usar `--providers.file.filename` en vez de `--providers.docker`
  - Traefik monta `./traefik-dynamic.yml:/etc/traefik/dynamic.yml:ro` en vez del Docker socket
  - Version de Traefik: `v3.3` → `v3.4`

**Verificación post-fix:**
```
curl -I http://localhost       → 308 Permanent Redirect → https
curl -kI https://localhost     → 404 (esperado: Host header no matchea vpn.we-do.io)
```

Logs de Traefik: ya **sin errores de Docker API**. El único error restante es el esperado `NXDOMAIN` de Let's Encrypt (DNS todavía no cargado).

### 3.3 ⚠️ Flag pendiente de DNS

**Estado:** El A record `vpn.we-do.io` → `34.44.29.193` todavía no está cargado en el panel DNS de `we-do.io`.

**Impacto actual:**
- OpenVPN (UDP 1194) **funciona** — no depende de DNS
- Panel admin HTTPS **no funciona** hasta que DNS propague y Traefik emita el cert ACME

**Cuando se cargue el DNS:** Traefik reintenta automáticamente cada pocos segundos. El cert se emite y el panel queda accesible en `https://vpn.we-do.io` sin intervención manual.

---

## 4. Verificación de conexión con ThingsBoard (isolation check)

Se confirmó que la VPN **NO puede alcanzar** recursos de ThingsBoard:

- Sin peering entre `vpn-prod-vpc` y `tb-prod-vpc` → ruteo imposible
- Sin rutas manuales entre ambas VPCs
- `vpn-prod-sa` no tiene `secretmanager.secretAccessor` (que sí tiene `tb-prod-sa`)
- `vpn-prod-sa` no tiene acceso a `gs://integracion-tagoio-tb-prod-scripts` ni `-maintenance`
- Subnet de la VM VPN (10.30.1.0/24) no overlappa con ningún rango usado en tb-prod

---

## 5. Recursos accesibles (outputs de Terraform)

```
backup_bucket       = gs://integracion-tagoio-vpn-prod-backups
dns_record          = vpn.we-do.io → A → 34.44.29.193
persistent_disk     = vpn-prod-data
serial_logs_command = gcloud compute instances get-serial-port-output vpn-prod-vm --zone=us-central1-a
ssh_command         = gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap
vpn_admin_url       = https://vpn.we-do.io
vpn_static_ip       = 34.44.29.193
```

---

## 6. Próximos pasos

1. **Cargar A record DNS**: `vpn.we-do.io` → `34.44.29.193` en el panel DNS de `we-do.io`
2. **Esperar propagación** (5-60 min típico)
3. **Verificar certificado**:
   ```
   curl -I https://vpn.we-do.io
   ```
   Debe devolver 200 OK con certificado Let's Encrypt válido
4. **Probar login** en el panel con las credenciales (`ADMIN_PASSWORD`)
5. **Crear primer grupo y cliente** para validar flujo completo
6. **Probar conexión VPN** desde un cliente OpenVPN con el `.ovpn` descargado
7. **Hacer push del repo** con los cambios post-deploy:
   - `traefik-dynamic.yml` nuevo
   - `docker-compose.yml` actualizado (file provider)
   - `infra/scripts/startup.sh` actualizado (EASYRSA_BATCH fix)
   - `docs/infra_audit.md` actualizado (este archivo)
8. **Pasar el repo a público** en GitHub (para que futuras ejecuciones del startup script puedan hacer `git clone`)

---

## 7. Checklist de seguridad post-deploy

- [x] Panel admin no accesible por HTTP puro (redirige a HTTPS)
- [x] Puerto 8080 (Flask) NO accesible desde internet
- [x] SSH solo vía IAP (35.235.240.0/20)
- [x] ufw activo como segunda capa (OS-level firewall)
- [x] VPC aislada, sin peering con tb-prod-vpc
- [x] Service Account con permisos mínimos (solo logging, monitoring, bucket propio)
- [x] Disco persistente con `prevent_destroy = true`
- [x] Backups diarios a bucket externo con versionado y lifecycle 90 días
- [x] PKI persistente en disco separado del boot disk
- [ ] Certificado HTTPS válido (pendiente DNS)
- [ ] Primer login y flujo de creación de cliente probado (pendiente DNS)
