# Estado del Deploy OpenVPN WeDo

**Fecha:** 2026-04-14
**Autor:** GuilleFerru (con asistencia Claude Code)
**Propósito:** Resumen ejecutivo para retomar el trabajo en una sesión nueva

---

## TL;DR

La plataforma está **100% operativa** en GCP. DNS activo, cert Let's Encrypt emitido, VPN funcional con aislamiento de grupos verificado end-to-end. Persistencia validada con múltiples ciclos destroy-vm + recreate.

---

## 1. Contexto del proyecto

**Repo:** `https://github.com/GuilleFerru/openvpn_wedo.git`
**Working dir local:** `C:\Users\EDC-PC09\Documents\repos\openvpn_wedo`
**Panel admin:** `https://vpn.we-do.io`
**VPN server:** `34.44.29.193:1194/udp`

**Objetivo:** Administración de clientes OpenVPN organizados en grupos de red aislados. Cada grupo tiene su propio rango /24 dentro de 10.8.0.0/16. Hasta 255 grupos × 254 clientes.

**Caso de uso:** Admin se conecta desde PC para acceder remotamente a Gateways Milesight desplegados en campo. Los gateways no pueden perder conectividad — sin VPN no se pueden reconfigurar.

**Documentos de referencia en `docs/`:**
- `code_review.md` — Review del código
- `deploy.md` — Plan original de deploy
- `infra_audit.md` — Auditoría pre+post deploy
- `palette.md` — Paleta de colores WeDo (Pantone 158C / 426C / 422C)
- `ssh_acceso_vm.md` — Guía de acceso SSH via IAP
- `deploy_status.md` — **Este archivo**

---

## 2. Infraestructura

### 2.1 Recursos GCP (proyecto `integracion-tagoio`)

| Recurso | Nombre | Detalle |
|---------|--------|---------|
| VPC | `vpn-prod-vpc` | Custom-mode, aislada de tb-prod-vpc |
| Subnet | `vpn-prod-subnet` | `10.30.1.0/24` en us-central1 |
| Cloud Router + NAT | `vpn-prod-router` / `vpn-prod-nat` | us-central1, AUTO_ONLY |
| Firewall | `vpn-prod-fw-vpn` | UDP 1194 ← 0.0.0.0/0 |
| Firewall | `vpn-prod-fw-https` | TCP 80, 443 ← 0.0.0.0/0 |
| Firewall | `vpn-prod-fw-iap-ssh` | TCP 22 ← 35.235.240.0/20 (IAP only) |
| IP estática | `vpn-prod-static-ip` | `34.44.29.193` |
| Disco persistente | `vpn-prod-data` | 10 GB pd-balanced, `prevent_destroy = true` |
| VM | `vpn-prod-vm` | e2-small, Ubuntu 22.04 |
| Service Account | `vpn-prod-sa` | logging + monitoring + bucket writer |
| Bucket backups | `integracion-tagoio-vpn-prod-backups` | Versionado, lifecycle 90 días |
| Bucket state | `tfstate-vpn-prod` | State de Terraform |

### 2.2 Contenedores (4/4 running)

| Container | Imagen | Puertos |
|-----------|--------|---------|
| `openvpn` | `kylemanna/openvpn` | `1194/udp` |
| `openvpn-admin` | build local (Flask+Gunicorn) | interno 8080 |
| `docker-socket-proxy` | `tecnativa/docker-socket-proxy` | interno 2375 |
| `traefik` | `traefik:v3.4` | `80, 443/tcp` |

### 2.3 Datos persistentes (`/mnt/vpn-data/`)

Disco separado, sobrevive a destroy de VM. Contenido:

| Directorio | Contenido |
|---|---|
| `openvpn/` | PKI completa (CA, server cert, DH, ta.key, CRL, client certs/keys) |
| `clients/` | `clients.json` + archivos `.ovpn` |
| `ccd/` | Archivos CCD (asignación IP fija por cliente) |
| `letsencrypt/` | `acme.json` de Traefik (cert Let's Encrypt) |
| `.initialized` | Marker de PKI inicializada |

### 2.4 Volúmenes Docker (ambos external, bind al disco persistente)

| Volumen | Device | Propósito |
|---|---|---|
| `openvpn_openvpn_data` | `/mnt/vpn-data/openvpn` | PKI de OpenVPN |
| `traefik_letsencrypt` | `/mnt/vpn-data/letsencrypt` | Cert Let's Encrypt |

---

## 3. Certificados

### 3.1 PKI OpenVPN

| Cert | Ubicación | Vencimiento | Notas |
|---|---|---|---|
| CA | `pki/ca.crt` + `pki/private/ca.key` | 2036-04-11 (10 años) | Sin passphrase (`nopass`) |
| Server | `pki/issued/34.44.29.193.crt` | 2036-04-11 (10 años) | CN = IP pública |
| Clients | `pki/issued/<name>.crt` | 10 años desde creación | `EASYRSA_CERT_EXPIRE=3650` |

- La CA key NO tiene passphrase. El campo "Contraseña de la CA" fue eliminado del panel (nunca se usaba).
- IPs de clientes son one-shot: si se revoca un cliente, su IP no se reasigna.

### 3.2 Let's Encrypt (Traefik)

- Cert emitido por **Let's Encrypt R12** para `vpn.we-do.io`
- Renovación automática por Traefik (TLS-ALPN-01 challenge)
- `acme.json` persiste en disco (`/mnt/vpn-data/letsencrypt/`) → sobrevive a destroy-vm

---

## 4. Red VPN

### 4.1 Topología

```
Subnet: 10.8.0.0/16 (topology subnet)
Server gateway: 10.8.0.1

Grupo admin (0):  10.8.0.2 - 10.8.0.254   ← ve TODOS los grupos
Grupo N:          10.8.N.1 - 10.8.N.254   ← solo ve su propio grupo
```

### 4.2 Aislamiento (iptables en container openvpn)

```
ACCEPT  ESTABLISHED,RELATED
ACCEPT  tun0→tun0  src 10.8.0.0/24                     ← admin ve todo
ACCEPT  tun0→tun0  src 10.8.N.0/24 dst 10.8.N.0/24     ← intra-grupo (×255)
DROP    tun0→tun0                                        ← inter-grupo bloqueado
ACCEPT  tun0→eth0                                        ← VPN → internet
ACCEPT  eth0→tun0  ESTABLISHED,RELATED
```

**Verificado end-to-end:**
- Admin (10.8.0.2) → todos los grupos: OK
- GW WeDo (10.8.1.1) → mismo grupo (10.8.1.2): OK
- GW WeDo (10.8.1.1) → otro grupo (10.8.2.1): BLOQUEADO
- GW Schroeder (10.8.2.1) → admin (10.8.0.2): BLOQUEADO
- GW Schroeder (10.8.2.1) → WeDo (10.8.1.x): BLOQUEADO

### 4.3 Split tunnel

- **Sin `redirect-gateway`**: solo tráfico 10.8.x.x va por VPN, internet sale por la conexión local del cliente
- **Sin `block-outside-dns`**: removido post-gen (causaba corte de internet en Windows)
- **Sin push DNS**: removido (sobreescribía DNS del adaptador Ethernet → DNS queries se perdían)

Estas 3 líneas se eliminan automáticamente del `openvpn.conf` generado por `ovpn_genconfig` via `sed` en `startup.sh`.

---

## 5. Panel Admin (UI)

### 5.1 Stack

- **Backend:** Python 3.11, Flask, Gunicorn (2 workers)
- **Frontend:** Vanilla JS, CSS (Clay Dark theme), Lucide icons
- **DB:** `clients.json` (archivo JSON)
- **Auth:** Password simple desde `ADMIN_PASSWORD` env var

### 5.2 Funcionalidades

- Crear/editar grupos con monograma e IP range automático
- Crear clientes con asignación IP automática y generación de `.ovpn`
- Revocar clientes (irreversible, revoca cert + limpia archivos + restart OpenVPN)
- Ver conexiones activas en tiempo real (polling 30s)
- Ver clientes rechazados (sin CCD válido)
- Descargar `.ovpn` desde el panel
- Theme toggle (dark/light) persistente via localStorage

### 5.3 Paleta

Dark-only como default. Basada en identidad WeDo:
- Dark: `#1e2124` / Surface: `#2a2f35` / Orange: `#ee7623`
- Font: Outfit + JetBrains Mono
- Icons: Lucide (CDN)

---

## 6. Persistencia validada

Se realizaron **múltiples ciclos** `make destroy-vm` + `make apply` confirmando:

| Item | Persiste | Cómo |
|---|---|---|
| PKI (CA, certs, keys) | Si | Disco `vpn-prod-data` + volume bind |
| clients.json + .ovpn | Si | Disco → symlink `/opt/vpn/clients` |
| CCD configs | Si | Disco → symlink `/opt/vpn/ccd` |
| Cert Let's Encrypt | Si | Disco → volume `traefik_letsencrypt` bind |
| IP estática | Si | Recurso GCP separado de la VM |
| Marker `.initialized` | Si | Disco → skip PKI init |
| Grupos + clientes | Si | Dentro de clients.json en disco |

---

## 7. Bugs resueltos durante el deploy

| Bug | Causa raíz | Fix |
|---|---|---|
| `Failed to build the CA` | `easyrsa build-ca` promptea CN en non-TTY | `EASYRSA_BATCH=1` + `EASYRSA_REQ_CN` |
| Traefik Docker API error | Docker ≥27 rechaza `/v1.24/`, Traefik lo hardcodea | File provider en vez de Docker provider |
| PermissionError clients.json | Container `appuser` (UID 1000) sin write en root-owned dir | `chown -R 1000:1000` en startup.sh |
| `ifconfig not in same /30` | `ovpn_genconfig` sin `-s 10.8.0.0/16` + topology net30 default | `-s 10.8.0.0/16 -e "topology subnet"` |
| Admin client IP = server (10.8.0.1) | `clients.json` template en repo con `next_client: 1` | Template eliminado del repo, db.py usa `next_client: 2` |
| 403 en docker exec (conexiones) | docker-socket-proxy sin `EXEC: 1` | Agregado `EXEC: 1` |
| VPN corta internet | `redirect-gateway def1` en .ovpn (full tunnel) | Stripped en `_export_ovpn_config` via regex |
| VPN corta DNS | `push "dhcp-option DNS"` + `block-outside-dns` | Eliminados post-gen en startup.sh |
| Intra-grupo no se ve | iptables solo permitía tun0→tun0 para admin | Loop `/24` rules para todos los grupos |
| Cert LE se pierde en destroy | Volume `traefik_letsencrypt` en boot disk | Volume external bind a disco persistente |
| `infra/scripts/` ignorado por git | `.gitignore` root tenía `Scripts/` (case-insensitive Windows) | Cambiado a `/Scripts/` (solo root) |
| startup.sh no trackeado | Nunca fue `git add`'ed | Tracked + .gitignore fix |

---

## 8. Comandos útiles

```bash
# SSH a la VM
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap

# Serial logs (sin SSH)
gcloud compute instances get-serial-port-output vpn-prod-vm --zone=us-central1-a

# Deploy cambios
cd /opt/vpn && sudo git pull && sudo docker compose up -d --build openvpn-admin

# Recrear VM (preserva datos)
cd infra && make destroy-vm && make apply

# Clean start (wipe todo + recrear)
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="sudo rm -rf /mnt/vpn-data/.initialized /mnt/vpn-data/openvpn/* /mnt/vpn-data/clients/* /mnt/vpn-data/ccd/* /mnt/vpn-data/letsencrypt/*"
cd infra && make destroy-vm && make apply

# Ver estado
make ssh  # luego: sudo docker compose -f /opt/vpn/docker-compose.yml ps

# Verificar cert LE
echo | openssl s_client -connect vpn.we-do.io:443 -servername vpn.we-do.io 2>/dev/null | openssl x509 -noout -issuer -dates

# Ver cert de un cliente
sudo docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  openssl x509 -in /etc/openvpn/pki/issued/<CLIENT>.crt -noout -dates
```

---

## 9. VMs en el proyecto

| VM | Tipo | IP | Propósito |
|---|---|---|---|
| `vpn-prod-vm` | e2-small | 34.44.29.193 | OpenVPN + Admin panel |
| `tb-prod-chirpstack-vm` | e2-custom-medium-6144 | 34.44.235.226 | ChirpStack |
| `tb-prod-vm1` | e2-standard-4 | (sin IP pública) | ThingsBoard |

---

## 10. Aislamiento con ThingsBoard

| Aspecto | ThingsBoard | OpenVPN | Compartido |
|---------|-------------|---------|------------|
| VPC | `tb-prod-vpc` (10.20.0.0/20) | `vpn-prod-vpc` (10.30.1.0/24) | NO |
| Service Account | `tb-prod-sa` | `vpn-prod-sa` | NO |
| Firewall rules | `tb-prod-fw-*` | `vpn-prod-fw-*` | NO |
| Cloud SQL | PostgreSQL | No usa DB externa | NO |
| IP estática | LB global + ChirpStack IP | `vpn-prod-static-ip` | NO |
| Estado Terraform | `tfstate-thingsboard-prod` | `tfstate-vpn-prod` | NO |
| Proyecto GCP | `integracion-tagoio` | `integracion-tagoio` | SI (inevitable) |
| Billing | Mismo billing account | Mismo billing account | SI (inevitable) |

Cero acoplamiento excepto proyecto GCP y billing. Sin rutas de red, credenciales compartidas, ni dependencias de servicios.

---

## 11. Costos estimados (mensuales USD)

| Recurso | Costo aprox. |
|---------|-------------|
| VM e2-small (24/7) | ~$13 |
| Disco boot 20GB SSD | ~$3 |
| Disco persistente 10GB | ~$1 |
| IP estática (en uso) | ~$0 |
| Cloud NAT | ~$1 |
| Egress (< 1GB/mes) | ~$0 |
| **Total** | **~$18/mes** |

Tráfico VPN (UDP 1194) va directo a la IP pública de la VM, no pasa por NAT ni LB.

---

## 12. Lessons learned

1. **Traefik ≤ v3.5 hardcodea `/v1.24/`** en la Docker API. Docker ≥27 la rechaza. Usar siempre **file provider**.
2. **`ovpn_initpki nopass` no basta** en non-TTY — agregar `EASYRSA_BATCH=1` + `EASYRSA_REQ_CN`.
3. **`redirect-gateway` y `block-outside-dns`** rompen internet en split-tunnel. Eliminar ambos + push DNS post-genconfig.
4. **`ovpn_getclient`** embebe `redirect-gateway def1` por default. Stripearlo en el backend.
5. **`clients.json` template en el repo** pisa el default de `_create_default_db`. No incluir archivos de datos en el repo.
6. **`Scripts/` en `.gitignore`** en Windows matchea case-insensitive → `infra/scripts/` se ignora. Usar `/Scripts/` (root-only).
7. **Volúmenes Docker Compose** se prefijan con el nombre del proyecto. Para persist, usar `external: true` + crear manualmente con bind.
8. **IPs son one-shot**: una vez revocado un cliente, su IP no se recicla. Con 254 IPs por grupo, hay margen suficiente.
9. **10 años en EASYRSA_CERT_EXPIRE** para gateways remotos que no pueden reconfigurarse sin VPN.
10. **Gunicorn 2 workers + `threading.Lock`** = no hay lock cross-process. Para esta escala (un solo admin) no importa, pero no escala.
