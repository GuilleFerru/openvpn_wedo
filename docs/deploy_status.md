# Estado del Deploy OpenVPN WeDo — Handoff

**Fecha:** 2026-04-13
**Autor:** GuilleFerru (con asistencia Claude Code)
**Propósito:** Resumen ejecutivo para retomar el trabajo en una sesión nueva

---

## TL;DR

La infra está **100% deployada y funcionando** en GCP. Los 4 contenedores corren healthy. El único bloqueante restante es que el **DNS `vpn.we-do.io` todavía no apunta a la IP pública `34.44.29.193`**, lo cual impide que Traefik emita el cert Let's Encrypt.

Una vez cargado el A record, el resto se resuelve automáticamente.

---

## 1. Contexto del proyecto

**Repo:** `C:\Users\EDC-PC09\Documents\repos\openvpn_wedo`
**Repo remoto:** `https://github.com/GuilleFerru/openvpn_wedo.git` (actualmente **publico** — pasar a privado cuando quede operativo 100%)

**Goal original:** Deployar un sistema de administración OpenVPN en GCP en el mismo proyecto que ThingsBoard (`integracion-tagoio`), pero con **aislamiento total** (VPC, SA, firewall, state propios).

**Documentos de referencia en `docs/`:**
- `code_review.md` — Review del código previo al deploy (ya todas las fases implementadas)
- `deploy.md` — Plan original de deploy paso a paso
- `infra_audit.md` — Auditoría pre+post deploy, con todos los recursos creados y problemas resueltos
- `deploy_status.md` — **Este archivo** — handoff para retomar trabajo

---

## 2. Infraestructura deployada (todo en GCP `integracion-tagoio`)

### 2.1 Recursos GCP (15 creados por Terraform)

| Recurso | Nombre | Valor / Detalle |
|---------|--------|-----------------|
| VPC | `vpn-prod-vpc` | Custom-mode, sin peering con tb-prod-vpc |
| Subnet | `vpn-prod-subnet` | `10.30.1.0/24` en us-central1 |
| Cloud Router | `vpn-prod-router` | us-central1 |
| Cloud NAT | `vpn-prod-nat` | AUTO_ONLY |
| Firewall | `vpn-prod-fw-vpn` | UDP 1194 ← 0.0.0.0/0 |
| Firewall | `vpn-prod-fw-https` | TCP 80, 443 ← 0.0.0.0/0 |
| Firewall | `vpn-prod-fw-iap-ssh` | TCP 22 ← 35.235.240.0/20 (IAP only) |
| IP estática | `vpn-prod-static-ip` | **`34.44.29.193`** |
| Disco persistente | `vpn-prod-data` | 10 GB pd-balanced, **`prevent_destroy = true`** |
| VM | `vpn-prod-vm` | e2-small, Ubuntu 22.04, boot 20 GB, IP interna `10.30.1.2` |
| Service Account | `vpn-prod-sa` | logging + monitoring + bucket writer |
| Bucket GCS | `integracion-tagoio-vpn-prod-backups` | Versionado, lifecycle 90 días |
| Bucket GCS (state) | `tfstate-vpn-prod` | State de Terraform (creado manualmente con `gcloud`) |

### 2.2 Contenedores en la VM (4/4 running)

| Container | Imagen | Estado | Puertos host |
|-----------|--------|--------|--------------|
| `openvpn` | `kylemanna/openvpn` | Up | `1194/udp` |
| `openvpn-admin` | `vpn-openvpn-admin` (build local) | Up (healthy) | — (solo interno) |
| `docker-socket-proxy` | `tecnativa/docker-socket-proxy` | Up | — (solo interno) |
| `traefik` | **`traefik:v3.4`** | Up | `80, 443/tcp` |

### 2.3 Arquitectura final

```
Internet
   │
   ├── UDP 1194 ──────────► openvpn container ──► PKI en /mnt/vpn-data/openvpn
   │
   ├── TCP 80/443 ─────────► traefik v3.4 ──► openvpn-admin:8080 (Flask+Gunicorn)
   │                            │
   │                            └── cert Let's Encrypt (pendiente DNS)
   │
   └── TCP 22 (solo IAP) ──► sshd (OS-level)

   ufw (segunda capa)       GCP firewall rules (primera capa)
```

**Datos persistentes:** `/mnt/vpn-data/` (disco separado, sobrevive a destroy de VM)
- `openvpn/` — PKI completa (CA, server cert, dh.pem, ta.key, crl.pem)
- `clients/` — clients.json + archivos .ovpn
- `ccd/` — configs fijas por cliente
- `.initialized` — marker de primera ejecución

**Backups:** Cron `/etc/cron.d/vpn-backup` corre diariamente 02:00 UTC → sube a `gs://integracion-tagoio-vpn-prod-backups/`

---

## 3. Lo que se hizo durante esta sesión

### Fase 1 — Análisis y planning
- Análisis de la infra existente de ThingsBoard en el repo `Infa_sep/ThingsBoard_GCP`
- Creación de `docs/deploy.md` con el plan original
- Decisión arquitectónica: VPC separada, sin peering, SA propio

### Fase 2 — Creación del Terraform
Estructura creada en `infra/`:
```
infra/
├── providers.tf          ← backend GCS + Google provider 5.30
├── variables.tf          ← 9 variables (admin_password, secret_key sensitive)
├── terraform.tfvars.example
├── terraform.tfvars      ← con valores reales (GITIGNORED)
├── network.tf            ← VPC, subnet, router, NAT
├── firewall.tf           ← 3 reglas
├── compute.tf            ← VM + IP estática + disco persistente attached
├── iam.tf                ← SA + roles
├── storage.tf            ← bucket de backups
├── outputs.tf            ← IPs, URLs, comandos SSH
├── scripts/
│   └── startup.sh        ← init script con ufw, Docker, PKI, docker compose
├── Makefile              ← init, plan, apply, ssh, logs, destroy
└── .gitignore            ← terraform.tfvars, .terraform/
```

### Fase 3 — Ajustes de persistencia
**Problema:** Con setup inicial, destruir la VM borraba todos los datos VPN.

**Solución aplicada:**
- Agregado `google_compute_disk.vpn_data` con `prevent_destroy = true`
- Disco montado en `/mnt/vpn-data/` vía startup script
- Symlinks `clients/` y `ccd/` → disco persistente
- Docker volume apunta al disco persistente
- Bucket GCS para backups con lifecycle 90 días y versionado

### Fase 4 — Skill `secure-linux-web-hosting`
Auditoría con el skill reveló que el único item faltante era el **firewall OS-level (ufw)** como segunda capa. Agregado al startup script — defense in depth.

### Fase 5 — Verificación pre-deploy
Creado `docs/infra_audit.md` con consulta directa a GCP vía `gcloud`:
- ✅ Ningún recurso con nombre `vpn-prod-*` existente
- ✅ Ningún overlap de rangos IP (tb usa 10.20.1.0/24, 10.91.0.0/16; nosotros 10.30.1.0/24)
- ✅ Cuota de CPU/IPs/discos con margen
- ✅ `gferrucci@dickcostantinosa.com.ar` tiene `roles/owner`

### Fase 6 — Fix de `.gitignore`
- Agregado al root: `.claude/`, `.agents/`, `skills-lock.json`
- Removido de `infra/.gitignore`: `.terraform.lock.hcl` (ese archivo **sí debe commitearse**)
- Verificado: `terraform.tfvars`, `.env`, certs, claves — todo ignorado

### Fase 7 — Deploy (`terraform apply`)
- Bucket de estado `tfstate-vpn-prod` creado manualmente antes del init
- `terraform init` + `terraform apply -auto-approve`
- **15 recursos creados exitosamente** en ~2 minutos
- Output: **`vpn_static_ip = "34.44.29.193"`**

### Fase 8 — Problemas post-deploy y sus fixes

#### Problema 1: `Failed to build the CA`

**Síntoma:** El startup script falló en paso 9/9 durante `docker compose run --rm openvpn ovpn_initpki nopass`.

**Causa raíz:** `easyrsa build-ca` prompteaba interactivamente por el Common Name. En modo non-TTY (startup script de GCE), el prompt retorna vacío y falla.

**Fix aplicado:**
```bash
docker compose run --rm \
  -e EASYRSA_BATCH=1 \
  -e EASYRSA_REQ_CN="OpenVPN-CA" \
  openvpn ovpn_initpki nopass
```

**Estado:** Aplicado manualmente en la VM actual. **También actualizado en `infra/scripts/startup.sh`** para que futuras recreaciones funcionen solas.

#### Problema 2: Traefik no podía leer la Docker API

**Síntoma:**
```
Failed to retrieve information of the docker client and server host
error="Error response from daemon: client version 1.24 is too old.
Minimum supported API version is 1.44"
```

**Causa raíz:** Ubuntu 22.04 actualmente shipea `docker.io v29.1.3` (muy nuevo), que rechaza URLs `/v1.24/*`. Traefik (probado v3.3, v3.4, v3.5) **hardcodea `/v1.24/` en sus llamadas a la Docker API**. La env var `DOCKER_API_VERSION=1.44` no ayuda porque Traefik no usa `NewClientFromEnv()`.

Verificado con `curl` directo al socket:
- `GET /v1.24/version` → **400** (rechazado)
- `GET /v1.44/version` → **200** OK
- `GET /version` → **200** OK

**Fix aplicado:** Cambiar Traefik del **Docker provider** al **file provider** con config estática.

Cambios en `docker-compose.yml`:
- Upgrade `traefik:v3.3` → `traefik:v3.4`
- Removidas las `labels` de `openvpn-admin`
- Traefik ahora usa `--providers.file.filename=/etc/traefik/dynamic.yml`
- Eliminado el mount de `/var/run/docker.sock`
- Agregado mount de `./traefik-dynamic.yml`

Nuevo archivo `traefik-dynamic.yml` (raíz del repo):
```yaml
http:
  routers:
    openvpn-admin:
      rule: 'Host(`{{env "DOMAIN"}}`)'
      entryPoints: [websecure]
      service: openvpn-admin
      tls:
        certResolver: le
  services:
    openvpn-admin:
      loadBalancer:
        servers:
          - url: "http://openvpn-admin:8080"
```

**Verificación post-fix:**
- `curl -I http://localhost` → `308 Permanent Redirect` (redirige a HTTPS)
- `curl -kI https://localhost` → `404` (esperado, Host no matchea `vpn.we-do.io`)
- Logs de Traefik: sin errores de Docker API, solo el error esperado `NXDOMAIN` de ACME (pendiente DNS)

---

## 4. ⏳ Lo que falta hacer

### 4.1 🚨 BLOQUEANTE — Cargar DNS

En el panel DNS de `we-do.io` (cPanel o similar), agregar:

```
Tipo:  A
Host:  vpn
Valor: 34.44.29.193
TTL:   300
```

Esto resuelve `vpn.we-do.io` → `34.44.29.193`.

Una vez propagado (5-60 min), Traefik emite el cert Let's Encrypt automáticamente sin intervención manual — ya está en loop de reintentos.

**Cómo verificar que el cert se emitió:**
```bash
curl -I https://vpn.we-do.io
# Debe devolver HTTP/2 200 con cert válido
```

### 4.2 Git push y pasar repo a público

El repo tiene commits pendientes con los cambios post-deploy. Archivos modificados:
- `docker-compose.yml` — Traefik file provider
- `traefik-dynamic.yml` — **nuevo**
- `infra/scripts/startup.sh` — fix de EASYRSA_BATCH
- `docs/infra_audit.md` — reporte actualizado
- `docs/deploy_status.md` — **este archivo**
- `infra/*.tf` — toda la infra Terraform
- `.gitignore` — fixes
- Varios archivos del admin panel (blueprints, config.py, etc) que ya estaban modificados antes de esta sesión

**Pasos:**
1. `git status` para ver todo
2. `git add` de los archivos seguros (NO `terraform.tfvars`)
3. `git commit -m "..."`
4. `git push origin master`
5. En GitHub, pasar el repo de privado a público

**⚠️ Importante:** Verificar antes del push que `terraform.tfvars` y `.env` **no** están en staged. El `git check-ignore` ya confirmó que están excluidos, pero no está de más verificar.

### 4.3 Verificación funcional end-to-end

Una vez cargado el DNS y emitido el cert:

1. **Login al panel**
   - Ir a `https://vpn.we-do.io`
   - Usuario: (no tiene, es solo password)
   - Password: `Edc_2820%IoT!`

2. **Crear primer grupo de prueba**
   - Verificar que genera la ruta correcta

3. **Crear primer cliente VPN**
   - Verificar generación del `.ovpn`
   - Verificar que aparece en `clients.json`
   - Verificar creación del archivo CCD con IP fija

4. **Conectar con un cliente OpenVPN real**
   - Importar el `.ovpn` en un dispositivo
   - Verificar que resuelve a `34.44.29.193:1194`
   - Verificar handshake exitoso
   - Verificar ping al gateway `10.8.0.1`

5. **Verificar backup**
   - Correr manualmente: `sudo bash /opt/vpn/backup.sh` en la VM
   - Verificar archivos en `gs://integracion-tagoio-vpn-prod-backups/`
   - Al día siguiente verificar que el cron corrió solo a las 02:00 UTC

### 4.4 (Opcional) Limpieza de CCD orphan files

El code review original mencionó 3 archivos CCD orphans en el repo local:
- `ccd/GW001`
- `ccd/GW001-Valija`
- `ccd/WeDo_Admin`

Están en `.gitignore` (`ccd/*`) así que no se van a subir al repo. Pero si los querés limpiar del disco local:
```powershell
Remove-Item C:\Users\EDC-PC09\Documents\repos\openvpn_wedo\ccd\GW001*
Remove-Item C:\Users\EDC-PC09\Documents\repos\openvpn_wedo\ccd\WeDo_Admin
```

---

## 5. Datos clave para la próxima sesión

### Credenciales
- `ADMIN_PASSWORD`: `Edc_2820%IoT!` (panel web)
- `SECRET_KEY`: `0da8945abf8dfdb802b296eb3428ab575de2dc8b37e01e03b74d880ccb179b68` (Flask session)
- Guardadas en `infra/terraform.tfvars` (GITIGNORED)

### Comandos útiles
```bash
# SSH a la VM (desde la maquina local con gcloud autenticado)
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap

# Ver logs de startup (serial port)
gcloud compute instances get-serial-port-output vpn-prod-vm --zone=us-central1-a

# En la VM: ver contenedores
sudo docker compose -f /opt/vpn/docker-compose.yml ps

# En la VM: ver logs de Traefik (para monitorear emisión de cert)
sudo docker logs traefik 2>&1 | tail -20

# Terraform (desde infra/)
terraform plan
terraform apply
make ssh        # atajo para SSH
make logs       # atajo para serial logs
make destroy-vm # destruye solo la VM (preserva disco y bucket)
```

### URLs y endpoints
- Panel admin: `https://vpn.we-do.io` (pendiente DNS)
- VPN servidor: `34.44.29.193:1194/udp`
- IP estática: `34.44.29.193`
- Bucket backups: `gs://integracion-tagoio-vpn-prod-backups`
- Bucket state: `gs://tfstate-vpn-prod`
- GitHub: `https://github.com/GuilleFerru/openvpn_wedo` (privado — pasar a público)

### Autenticación
- gcloud user: `gferrucci@dickcostantinosa.com.ar` (roles/owner en `integracion-tagoio`)
- ADC para Terraform: `gcloud auth application-default login` (re-autenticar si da "invalid_rapt")

### Aislamiento con ThingsBoard
Cero acoplamiento excepto el proyecto GCP y el billing. Ver tabla completa en `docs/infra_audit.md` sección 2.

---

## 6. Lessons learned para futuros deploys

1. **Ubuntu 22.04 en GCE shipea `docker.io` v29+** (inusualmente nuevo) con API mínima 1.44. Traefik ≤ v3.5 hardcodea `/v1.24/` y rompe. **Usar siempre file provider** en lugar de Docker provider para evitar el problema.

2. **`ovpn_initpki nopass` no es suficiente** para modo non-interactive — también hay que setear `EASYRSA_BATCH=1` y `EASYRSA_REQ_CN`.

3. **El `.terraform.lock.hcl` debe commitearse** (no ignorarse) para pinnear versiones de providers entre colaboradores.

4. **`gcloud auth login` ≠ `gcloud auth application-default login`** — el primero autentica el CLI, el segundo autentica las librerías (incluido Terraform). Si Terraform da "invalid_rapt", usar el segundo.

5. **Los secrets en Terraform van por metadata de la VM**, no en el código. El startup script los lee con `curl http://metadata.google.internal/computeMetadata/v1/instance/attributes/<name>`.

6. **Patrón de disco persistente + bucket GCS** = mejor que solo uno u otro. El disco protege contra destroy accidental de VM, el bucket protege contra destroy accidental del disco.

7. **Defense in depth con ufw** — incluso teniendo GCP firewall rules, agregarlo a nivel OS es valioso. El skill `secure-linux-web-hosting` lo recomendó y es correcto.
