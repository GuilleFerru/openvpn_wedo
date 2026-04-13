# Auditoría de Infraestructura GCP — Pre-deploy OpenVPN

**Fecha:** 2026-04-13
**Proyecto:** `integracion-tagoio`
**Método:** Consulta directa a GCP vía `gcloud` (estado real, no declarado)

---

## 1. Estado actual en GCP

### 1.1 Networks (VPCs)

| Nombre | Modo | Uso |
|--------|------|-----|
| `default` | Auto-mode (subnets en todas las regiones) | No usada activamente |
| `tb-prod-vpc` | Custom-mode | ThingsBoard + ChirpStack |

### 1.2 Subnets relevantes

| Subnet | Región | CIDR | Network |
|--------|--------|------|---------|
| `tb-prod-subnet` | us-central1 | **`10.20.1.0/24`** | tb-prod-vpc |
| `default` | us-central1 | `10.128.0.0/20` | default |

### 1.3 VMs activas

| Nombre | Zona | Tipo | IP Interna | IP Externa | Estado |
|--------|------|------|------------|------------|--------|
| `tb-prod-vm1` | us-central1-a | e2-standard-4 | 10.20.1.11 | (sin externa, via LB) | RUNNING |
| `tb-prod-chirpstack-vm` | us-central1-a | e2-custom-medium-6144 | 10.20.1.20 | 34.44.235.226 | RUNNING |

### 1.4 IPs estáticas reservadas

| Nombre | Tipo | Address | Estado |
|--------|------|---------|--------|
| `tb-prod-web-ip` | Global EXTERNAL | 34.160.1.110 | IN_USE (LB web) |
| `nat-auto-ip-...` | Regional EXTERNAL | 136.119.37.138 | IN_USE (Cloud NAT) |
| `tb-prod-tts-ip` | Regional EXTERNAL | 136.114.172.177 | RESERVED (sin uso) |
| `tb-prod-tts-tbmq-ip` | Regional EXTERNAL | 34.44.235.226 | IN_USE (ChirpStack VM) |
| `tb-prod-sn-range` | Internal range | 10.91.0.0 | RESERVED (peering Cloud SQL) |
| `tb-prod-chirpstack-private-ip` | Internal | 10.20.1.20 | IN_USE |
| `tb-prod-tts-tbmq-private-ip` | Internal | 10.20.1.10 | RESERVED |

### 1.5 Firewall rules

| Nombre | Network | Origen | Permite | Target tags |
|--------|---------|--------|---------|-------------|
| `default-allow-icmp` | default | 0.0.0.0/0 | icmp | - |
| `default-allow-internal` | default | 10.128.0.0/9 | todo | - |
| `default-allow-rdp` | default | 0.0.0.0/0 | tcp:3389 | - |
| `default-allow-ssh` | default | 0.0.0.0/0 | tcp:22 | - |
| `tb-prod-chirpstack-external` | tb-prod-vpc | 0.0.0.0/0 | 80, 443, 1700-2, 1883, 3000-2, 8883-4, 9883-4, 9084 | tb-prod-chirpstack |
| `tb-prod-fw-iap-ssh` | tb-prod-vpc | 35.235.240.0/20 | tcp:22 | tb-prod-iap-ssh, tb-prod-app |
| `tb-prod-fw-iot` | tb-prod-vpc | 0.0.0.0/0 | tcp:1883, tcp:1889, udp:5683 | tb-prod-app |
| `tb-prod-fw-lb-health-checks` | tb-prod-vpc | 130.211.0.0/22, 35.191.0.0/16 | tcp:8080 | tb-prod-app |
| `tb-prod-tts-external` | tb-prod-vpc | 0.0.0.0/0 | 1700, 1883-9, 8883-7, 9083-4 | tb-prod-tts |

### 1.6 Discos persistentes

| Nombre | Zona | Tamaño | Tipo |
|--------|------|--------|------|
| `tb-prod-vm1` | us-central1-a | 50 GB | pd-balanced |
| `tb-prod-chirpstack-vm` | us-central1-a | 50 GB | pd-balanced |
| `tb-prod-chirpstack-data` | us-central1-a | 50 GB | pd-balanced |

### 1.7 Cloud Routers

| Nombre | Región | Network |
|--------|--------|---------|
| `tb-prod-router` | us-central1 | tb-prod-vpc |

### 1.8 Cloud SQL

| Nombre | Versión | Tier | IP Privada | Estado |
|--------|---------|------|------------|--------|
| `tb-prod-pg` | POSTGRES_15 | db-custom-1-4096 | 10.91.0.3 | RUNNABLE |

### 1.9 Service Accounts (relevantes)

| Email | Display Name |
|-------|--------------|
| `tb-prod-sa@integracion-tagoio.iam.gserviceaccount.com` | SA tb-prod VMs |
| `874122785329-compute@developer.gserviceaccount.com` | Default compute SA |
| `integracion-tagoio@appspot.gserviceaccount.com` | App Engine default |
| `python-arima-access@...` | python-arima-access |

### 1.10 Load Balancers

| Forwarding Rule | IP | Puerto | Target |
|----------------|----|----|--------|
| `tb-prod-http-redirect-rule` | 34.160.1.110 | 80 | tb-prod-http-redirect-proxy |
| `tb-prod-https-forwarding-rule` | 34.160.1.110 | 443 | tb-prod-https-proxy |

### 1.11 Storage Buckets

| Nombre | Location |
|--------|----------|
| `integracion-tagoio-tb-prod-maintenance` | US-CENTRAL1 |
| `integracion-tagoio-tb-prod-scripts` | US-CENTRAL1 |
| `tfstate-thingsboard-prod` | US-CENTRAL1 |
| `tfstate-vpn-prod` | US-CENTRAL1 (creado para este deploy) |
| `run-sources-integracion-tagoio-us-central1` | US-CENTRAL1 |
| `run-sources-integracion-tagoio-southamerica-west1` | SOUTHAMERICA-WEST1 |

---

## 2. Infraestructura nueva propuesta (OpenVPN)

### 2.1 Recursos a crear

| Tipo | Nombre | Detalle |
|------|--------|---------|
| VPC | `vpn-prod-vpc` | Custom-mode, aislada |
| Subnet | `vpn-prod-subnet` | **`10.30.1.0/24`** en us-central1 |
| Cloud Router | `vpn-prod-router` | us-central1 |
| Cloud NAT | `vpn-prod-nat` | AUTO_ONLY |
| Firewall | `vpn-prod-fw-vpn` | UDP 1194 desde 0.0.0.0/0 → tag `vpn-prod-app` |
| Firewall | `vpn-prod-fw-https` | TCP 80, 443 desde 0.0.0.0/0 → tag `vpn-prod-app` |
| Firewall | `vpn-prod-fw-iap-ssh` | TCP 22 desde 35.235.240.0/20 → tag `vpn-prod-iap-ssh` |
| IP Estática | `vpn-prod-static-ip` | Regional EXTERNAL |
| Disco | `vpn-prod-data` | 10 GB pd-balanced, `prevent_destroy` |
| VM | `vpn-prod-vm` | e2-small (2 vCPU, 2 GB), Ubuntu 22.04, boot 20 GB |
| Service Account | `vpn-prod-sa` | Logging + Monitoring + Storage bucket writer |
| Bucket | `integracion-tagoio-vpn-prod-backups` | US-CENTRAL1, versionado, lifecycle 90 días |
| IAM project-level | `roles/logging.logWriter` | → vpn-prod-sa |
| IAM project-level | `roles/monitoring.metricWriter` | → vpn-prod-sa |
| IAM bucket-level | `roles/storage.objectAdmin` | → vpn-prod-sa (solo en bucket nuevo) |

**Total: 15 recursos Terraform a crear.**

---

## 3. Análisis de conflictos

### 3.1 Nombres de recursos

Se verificó cada recurso planificado contra el estado real:

| Recurso planificado | Existe ya? | Conflicto |
|---------------------|-----------|-----------|
| VPC `vpn-prod-vpc` | NO | ✅ Sin conflicto |
| Subnet `vpn-prod-subnet` | NO | ✅ Sin conflicto |
| Router `vpn-prod-router` | NO (existe `tb-prod-router`) | ✅ Sin conflicto |
| NAT `vpn-prod-nat` | NO | ✅ Sin conflicto |
| Firewall `vpn-prod-fw-*` | NO | ✅ Sin conflicto |
| IP `vpn-prod-static-ip` | NO | ✅ Sin conflicto |
| Disco `vpn-prod-data` | NO | ✅ Sin conflicto |
| VM `vpn-prod-vm` | NO | ✅ Sin conflicto |
| SA `vpn-prod-sa` | NO (existe `tb-prod-sa`) | ✅ Sin conflicto |
| Bucket `integracion-tagoio-vpn-prod-backups` | NO | ✅ Sin conflicto |

### 3.2 Rangos IP (overlap)

| Red | CIDR | Overlap con 10.30.1.0/24? |
|-----|------|---------------------------|
| `tb-prod-subnet` | 10.20.1.0/24 | ❌ NO (rangos distintos) |
| `tb-prod-sn-range` (Cloud SQL) | 10.91.0.0/16 | ❌ NO |
| `default` us-central1 | 10.128.0.0/20 | ❌ NO |

**Además, las VPCs están aisladas**: no hay peering entre `tb-prod-vpc` y `vpn-prod-vpc`, así que incluso si hubiese overlap no afectaría el ruteo.

### 3.3 Firewall rules — colisión de puertos

Las firewall rules son por VPC, así que **no hay colisión** aunque los puertos se repitan:

| Puerto | tb-prod-vpc abre | vpn-prod-vpc abrirá |
|--------|-----------------|---------------------|
| 22/tcp | Sí (IAP) | Sí (IAP) — independiente |
| 80/tcp | No (LB HTTPS) | Sí — independiente |
| 443/tcp | No (via LB) | Sí — independiente |
| 1194/udp | No | Sí — **NUEVO, solo en vpn-vpc** |
| 1883/tcp | Sí (IoT) | No |
| 5683/udp | Sí (CoAP) | No |

### 3.4 IAM a nivel proyecto

Se agregarán 2 bindings a `vpn-prod-sa`:
- `roles/logging.logWriter`
- `roles/monitoring.metricWriter`

Estos roles **son aditivos y ya están asignados a `tb-prod-sa`** en paralelo. Terraform solo agrega members, no remueve. **Sin conflicto.**

### 3.5 Service Account Token scoping

El SA `tb-prod-sa` tiene permisos de `secretmanager.secretAccessor` y acceso a buckets de scripts de TB. El nuevo `vpn-prod-sa` **no tiene acceso a ninguno de esos recursos** — el aislamiento lateral está garantizado.

### 3.6 Cuotas de proyecto

Recursos a consumir de las cuotas:
- **CPUs región us-central1**: +2 vCPU (e2-small). Actualmente hay `tb-prod-vm1` (4) + `tb-prod-chirpstack-vm` (2) = 6. Total post-deploy: 8. Cuota default: 24+ → ✅
- **IPs externas regionales**: +1. Actualmente 3 reservadas → ✅
- **Networks**: +1 (actualmente 2) → ✅ (cuota default 5)
- **Persistent disks SSD GB**: +30 GB (20 boot + 10 data) → ✅
- **Storage buckets**: +1 → ✅

### 3.7 DNS

El dominio `vpn.we-do.io` **no está registrado aún** en ningún A record de GCP. Tenés que agregarlo manualmente en el panel DNS de `we-do.io` **después** del `terraform apply`, apuntando a la IP que devuelva el output `vpn_static_ip`.

---

## 4. Potenciales problemas y mitigaciones

| Riesgo | Probabilidad | Mitigación |
|--------|-------------|------------|
| Sesión `gcloud` expira a mitad del `apply` | Media | Re-auth con `gcloud auth application-default login` antes del apply |
| DNS no propagado al primer arranque → Let's Encrypt falla | Alta | Traefik reintenta cada 5 min; configurar DNS **antes** del apply |
| APIs de GCP no habilitadas (`compute.googleapis.com`, `storage.googleapis.com`, `iam.googleapis.com`) | Baja | Ya están habilitadas (los tb-prod-* ya las usan) |
| Disco persistente `vpn-prod-data` no se puede destruir por `prevent_destroy` | Baja (intencional) | Sacar `prevent_destroy` manualmente antes de `destroy` si hace falta |
| `force_destroy=false` en bucket de backups — no se puede `terraform destroy` si tiene objetos | Baja (intencional) | Vaciar bucket manualmente antes de `destroy` si hace falta |
| Startup script clona desde `github.com/GuilleFerru/openvpn_wedo.git` — ¿repo público? | **Alta** | **Verificar**: si el repo es privado, el `git clone` falla sin auth. Soluciones: hacerlo público, usar SSH deploy key, o subir tarball a GCS |

> ⚠️ **Item más importante:** confirmar que el repo GitHub es público o configurar autenticación antes del primer `apply`.

---

## 5. Conclusión

**No hay conflictos bloqueantes.** Los 15 recursos a crear:

- Viven en una VPC nueva (`vpn-prod-vpc`) sin peering ni rutas hacia `tb-prod-vpc`
- Usan un CIDR (`10.30.1.0/24`) que no se superpone con ningún rango existente
- Tienen prefijo de nombres único (`vpn-prod-*`)
- El Service Account nuevo está scoped al bucket de backups propio, sin acceso a recursos TB
- El consumo de cuota es marginal (+2 vCPU, +1 IP, +30 GB disk)

**Acciones previas recomendadas antes del `apply`:**

1. ✅ Re-autenticar ADC: `gcloud auth application-default login`
2. ⚠️ **Verificar que `https://github.com/GuilleFerru/openvpn_wedo.git` es accesible sin auth** (o configurar otra forma de pull)
3. ⚠️ **Configurar el A record DNS `vpn.we-do.io` → IP que devuelva Terraform** (se puede hacer después, pero antes de verificar HTTPS)

Una vez hechos estos checks, el `terraform apply` es seguro.
