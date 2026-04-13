# Plan de Deploy — OpenVPN WeDo en GCP

**Fecha:** 2026-03-27
**Proyecto GCP:** `integracion-tagoio`
**Región/Zona:** `us-central1-a`
**Dominio previsto:** `vpn.we-do.io`

---

## 0. Principios de diseño

1. **Aislamiento de red**: VPC separada de ThingsBoard. Sin peering, sin rutas compartidas, sin acceso lateral.
2. **Superficie mínima**: Solo los puertos estrictamente necesarios abiertos al público.
3. **Infraestructura como código**: Todo definido en Terraform dentro de este repositorio (`infra/`).
4. **Sin dependencias cruzadas**: Service account propio, firewall propio, IP propia. Si ThingsBoard se cae, la VPN sigue funcionando y viceversa.

---

## 1. Arquitectura objetivo

```
                      Internet
                         │
                ┌────────┴────────┐
                │  IP Estática GCE │
                │  (vpn.we-do.io)  │
                └────────┬────────┘
                         │
          ┌──────────────┼──────────────┐
          │ UDP 1194     │ TCP 443/80   │ TCP 22
          │              │              │ (solo IAP)
          ▼              ▼              ▼
     ┌─────────┐   ┌──────────┐   ┌─────────┐
     │ OpenVPN │   │ Traefik  │   │  SSH    │
     │ Server  │   │ (HTTPS + │   │ via IAP │
     │ :1194   │   │  LE cert)│   └─────────┘
     └─────────┘   └────┬─────┘
                        │ :8080
                   ┌────▼─────┐
                   │  Flask   │
                   │  Admin   │
                   │(Gunicorn)│
                   └──────────┘
                        │
                   Docker Socket
                   Proxy (filtrado)
```

### Componentes en la VM

| Contenedor | Imagen | Puertos expuestos | Función |
|-----------|--------|-------------------|---------|
| `openvpn` | kylemanna/openvpn | UDP 1194 (host) | Servidor VPN |
| `openvpn-admin` | Build local (`admin/`) | 8080 (interno) | Panel de administración Flask/Gunicorn |
| `traefik` | traefik:v3.3 | TCP 80, 443 (host) | Reverse proxy HTTPS + Let's Encrypt automático |
| `docker-socket-proxy` | tecnativa/docker-socket-proxy | 2375 (interno) | Proxy filtrado al Docker socket |

---

## 2. Recursos GCP a crear

### 2.1 Red (VPC dedicada)

| Recurso | Nombre | Configuración |
|---------|--------|---------------|
| VPC | `vpn-prod-vpc` | Sin auto-subnets, regional routing |
| Subnet | `vpn-prod-subnet` | `10.30.1.0/24` (sin overlap con `10.20.x.x` de TB) |
| Cloud Router | `vpn-prod-router` | us-central1 |
| Cloud NAT | `vpn-prod-nat` | Para que la VM pueda descargar paquetes sin IP pública directa en Docker |

> **¿Por qué VPC separada?** Si un atacante compromete la VPN, no tiene ruta de red hacia ThingsBoard, Cloud SQL, ni ChirpStack. El blast radius queda contenido.

### 2.2 Compute

| Recurso | Nombre | Configuración |
|---------|--------|---------------|
| VM | `vpn-prod-vm` | `e2-small` (2 vCPU, 2GB RAM) — suficiente para OpenVPN + Flask |
| Boot disk | — | 20GB SSD (pd-balanced), Ubuntu 22.04 |
| IP estática | `vpn-prod-static-ip` | Regional, us-central1 |
| Tags | — | `vpn-prod-app`, `vpn-prod-iap-ssh` |

**Justificación del tamaño:** OpenVPN usa ~50MB RAM por cada 100 conexiones concurrentes. Flask/Gunicorn con 2 workers usa ~100MB. Con 2GB sobra para el caso de uso (< 255 clientes simultáneos).

### 2.3 Firewall

| Regla | Protocolo | Puerto | Origen | Target tag |
|-------|-----------|--------|--------|------------|
| `vpn-prod-fw-vpn` | UDP | 1194 | 0.0.0.0/0 | `vpn-prod-app` |
| `vpn-prod-fw-https` | TCP | 80, 443 | 0.0.0.0/0 | `vpn-prod-app` |
| `vpn-prod-fw-iap-ssh` | TCP | 22 | 35.235.240.0/20 | `vpn-prod-iap-ssh` |

> **Nota:** NO se abre el puerto 8080 ni 8888. El panel admin solo es accesible a través de Caddy (443).

### 2.4 IAM

| Recurso | Nombre | Roles |
|---------|--------|-------|
| Service Account | `vpn-prod-sa` | `roles/logging.logWriter`, `roles/monitoring.metricWriter` |

> Sin `secretmanager.secretAccessor` — los secrets se inyectan vía startup script o metadata, no se consultan en runtime. Sin acceso a storage de TB.

### 2.5 DNS

| Registro | Tipo | Valor |
|----------|------|-------|
| `vpn.we-do.io` | A | IP estática de `vpn-prod-static-ip` |

Se configura en cPanel/DNS de `we-do.io` (mismo proveedor que `iot.we-do.io` y `ns.we-do.io`).

---

## 3. Pasos de implementación

### Paso 1 — Preparar estructura Terraform

Crear directorio `infra/` en este repositorio con la siguiente estructura:

```
infra/
├── providers.tf          # Google provider, backend GCS
├── variables.tf          # Variables de entrada
├── terraform.tfvars      # Valores específicos (gitignored)
├── network.tf            # VPC, subnet, router, NAT
├── firewall.tf           # 3 reglas de firewall
├── compute.tf            # VM, disco, IP estática
├── iam.tf                # Service account
├── outputs.tf            # IPs, SSH commands
├── scripts/
│   └── startup.sh        # Script de inicialización de la VM
└── Makefile              # Comandos de conveniencia
```

**Backend de estado:** Crear bucket `tfstate-vpn-prod` en GCS (separado del de ThingsBoard `tfstate-thingsboard-prod`).

### Paso 2 — Escribir Terraform

#### providers.tf
```hcl
terraform {
  required_version = ">= 1.6.0"
  backend "gcs" {
    bucket = "tfstate-vpn-prod"
    prefix = "terraform/state"
  }
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.30"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
```

#### variables.tf
```hcl
variable "project_id" {
  default = "integracion-tagoio"
}
variable "region" {
  default = "us-central1"
}
variable "zone" {
  default = "us-central1-a"
}
variable "domain_name" {
  default = "vpn.we-do.io"
}
variable "admin_password" {
  sensitive = true
}
variable "secret_key" {
  sensitive = true
}
```

#### network.tf
```hcl
resource "google_compute_network" "vpn_vpc" {
  name                    = "vpn-prod-vpc"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "vpn_subnet" {
  name          = "vpn-prod-subnet"
  ip_cidr_range = "10.30.1.0/24"
  region        = var.region
  network       = google_compute_network.vpn_vpc.id
  private_ip_google_access = true
}

resource "google_compute_router" "vpn_router" {
  name    = "vpn-prod-router"
  region  = var.region
  network = google_compute_network.vpn_vpc.id
}

resource "google_compute_router_nat" "vpn_nat" {
  name                               = "vpn-prod-nat"
  router                             = google_compute_router.vpn_router.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
```

#### firewall.tf
```hcl
resource "google_compute_firewall" "vpn" {
  name    = "vpn-prod-fw-vpn"
  network = google_compute_network.vpn_vpc.name
  allow {
    protocol = "udp"
    ports    = ["1194"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["vpn-prod-app"]
}

resource "google_compute_firewall" "https" {
  name    = "vpn-prod-fw-https"
  network = google_compute_network.vpn_vpc.name
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["vpn-prod-app"]
}

resource "google_compute_firewall" "iap_ssh" {
  name    = "vpn-prod-fw-iap-ssh"
  network = google_compute_network.vpn_vpc.name
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["vpn-prod-iap-ssh"]
}
```

#### compute.tf
```hcl
resource "google_compute_address" "vpn_static_ip" {
  name   = "vpn-prod-static-ip"
  region = var.region
}

resource "google_compute_instance" "vpn_vm" {
  name         = "vpn-prod-vm"
  machine_type = "e2-small"
  zone         = var.zone
  tags         = ["vpn-prod-app", "vpn-prod-iap-ssh"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2204-lts"
      size  = 20
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.vpn_subnet.id
    access_config {
      nat_ip = google_compute_address.vpn_static_ip.address
    }
  }

  metadata = {
    enable-oslogin = "TRUE"
    admin-password = var.admin_password
    secret-key     = var.secret_key
    domain-name    = var.domain_name
    public-ip      = google_compute_address.vpn_static_ip.address
  }

  metadata_startup_script = file("${path.module}/scripts/startup.sh")

  service_account {
    email  = google_service_account.vpn_sa.email
    scopes = ["https://www.googleapis.com/auth/cloud-platform"]
  }

  allow_stopping_for_update = true
}
```

#### iam.tf
```hcl
resource "google_service_account" "vpn_sa" {
  account_id   = "vpn-prod-sa"
  display_name = "VPN Production Service Account"
}

resource "google_project_iam_member" "vpn_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vpn_sa.email}"
}

resource "google_project_iam_member" "vpn_monitoring" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.vpn_sa.email}"
}
```

### Paso 3 — Escribir startup script

`infra/scripts/startup.sh` — se ejecuta al crear la VM:

```bash
#!/bin/bash
set -euo pipefail

# 1. Instalar Docker y Docker Compose
apt-get update
apt-get install -y docker.io docker-compose-v2 git curl
systemctl enable docker
systemctl start docker

# 2. Leer secrets desde metadata
ADMIN_PASSWORD=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/admin-password)
SECRET_KEY=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/secret-key)
DOMAIN=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/domain-name)
PUBLIC_IP=$(curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/public-ip)

# 3. Clonar el repositorio
cd /opt
git clone https://github.com/<org>/openvpn_wedo.git vpn
cd vpn

# 4. Crear .env
cat > .env <<EOF
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SECRET_KEY=${SECRET_KEY}
DOMAIN=${DOMAIN}
EOF

# 5. Inicializar OpenVPN (primera vez)
if [ ! -f /opt/vpn/.initialized ]; then
  docker compose run --rm openvpn ovpn_genconfig -u udp://${PUBLIC_IP}
  docker compose run --rm openvpn ovpn_initpki nopass
  touch /opt/vpn/.initialized
fi

# 6. Levantar servicios
docker compose up -d

# 7. Configurar backup diario (02:00 UTC)
cat > /etc/cron.d/vpn-backup <<'CRON'
0 2 * * * root /opt/vpn/backup.sh >> /var/log/vpn-backup.log 2>&1
CRON
```

### Paso 4 — docker-compose.yml para producción

El `docker-compose.yml` ya incluye Traefik v3.3 configurado con:
- Let's Encrypt automático vía ACME (HTTP challenge)
- Redirección HTTP → HTTPS
- Labels en `openvpn-admin` para auto-discovery del backend
- Volumen persistente para certificados (`traefik_letsencrypt`)

Solo verificar que la variable `DOMAIN` esté correcta en `.env` (usada por las labels de Traefik).

> **No se requieren cambios en docker-compose.yml** — Traefik ya está integrado.

### Paso 5 — Aplicar Terraform

```bash
# Desde la máquina local con gcloud autenticado
cd infra/

# Crear bucket de estado (una sola vez)
gcloud storage buckets create gs://tfstate-vpn-prod \
  --project=integracion-tagoio \
  --location=us-central1 \
  --uniform-bucket-level-access

# Inicializar y aplicar
terraform init
terraform plan -var="admin_password=<PASSWORD_SEGURO>" -var="secret_key=<SECRET_SEGURO>"
terraform apply -var="admin_password=<PASSWORD_SEGURO>" -var="secret_key=<SECRET_SEGURO>"
```

### Paso 6 — Configurar DNS

Agregar registro A en el panel DNS de `we-do.io`:

```
vpn.we-do.io  →  A  →  <IP de terraform output vpn_static_ip>
```

Esperar propagación DNS (puede tomar hasta 24h, normalmente < 1h).

### Paso 7 — Verificación post-deploy

```bash
# SSH a la VM vía IAP
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap

# Verificar contenedores corriendo
docker compose ps

# Verificar logs
docker compose logs -f

# Verificar HTTPS (desde local)
curl -I https://vpn.we-do.io

# Verificar VPN (desde un cliente)
# Descargar .ovpn desde el panel y conectar
```

---

## 4. Matriz de aislamiento TB ↔ VPN

| Aspecto | ThingsBoard | OpenVPN | ¿Compartido? |
|---------|-------------|---------|---------------|
| VPC | `tb-prod-vpc` (10.20.0.0/20) | `vpn-prod-vpc` (10.30.1.0/24) | NO |
| Service Account | `tb-prod-sa` | `vpn-prod-sa` | NO |
| Firewall rules | `tb-prod-fw-*` | `vpn-prod-fw-*` | NO |
| Cloud SQL | Sí (PostgreSQL) | No usa DB externa | NO |
| IP estática | LB global + ChirpStack IP | `vpn-prod-static-ip` | NO |
| Estado Terraform | `tfstate-thingsboard-prod` | `tfstate-vpn-prod` | NO |
| Proyecto GCP | `integracion-tagoio` | `integracion-tagoio` | SÍ (inevitable) |
| Billing | Mismo billing account | Mismo billing account | SÍ (inevitable) |

> **El único acoplamiento es el proyecto GCP y el billing.** No hay rutas de red, credenciales compartidas, ni dependencias de servicios entre ambas infraestructuras.

---

## 5. Costos estimados (mensuales USD)

| Recurso | Costo aprox. |
|---------|-------------|
| VM e2-small (24/7) | ~$13 |
| Disco 20GB SSD | ~$3 |
| IP estática (en uso) | ~$0 (gratis mientras está asignada a VM corriendo) |
| Cloud NAT | ~$1 |
| Egress (< 1GB/mes admin) | ~$0 |
| **Total** | **~$17/mes** |

> El tráfico VPN (UDP 1194) va directo a la IP pública de la VM, no pasa por NAT ni LB, así que no genera costos adicionales significativos.

---

## 6. Seguridad post-deploy

### Checklist

- [ ] Verificar que el panel admin responde SOLO por HTTPS (HTTP redirige a HTTPS)
- [ ] Verificar que puerto 8080 NO es accesible desde internet
- [ ] Verificar que SSH solo funciona vía IAP (`gcloud compute ssh --tunnel-through-iap`)
- [ ] Verificar que la VM no tiene acceso de red a `10.20.x.x` (TB)
- [ ] Cambiar password del panel admin (no usar el default de desarrollo)
- [ ] Verificar que `SECRET_KEY` es un valor aleatorio fuerte (32+ bytes hex)
- [ ] Verificar que backup.sh funciona y los archivos se generan en `/opt/vpn/backups/`
- [ ] Configurar alerta en Cloud Monitoring si la VM se cae

### Mejoras futuras (no bloqueantes)

- Subir backups a un bucket GCS dedicado (`vpn-prod-backups`)
- Agregar Cloud Armor WAF frente al panel admin (si se justifica por tráfico)
- Agregar alertas por intentos de login fallidos (parsear logs estructurados)
- Considerar disco persistente separado para datos VPN (PKI + clients.json)

---

## 7. Rollback

Si algo sale mal durante el deploy:

```bash
# Destruir solo la VM (preserva VPC y firewall para reintentar)
terraform destroy -target=google_compute_instance.vpn_vm

# Destruir todo
terraform destroy
```

Los datos de la VPN se pierden si se destruye la VM (están en el disco boot). Para producción con datos importantes, considerar un disco persistente separado con `prevent_destroy = true`.

---

## 8. Orden de ejecución resumido

```
1. Crear infra/ con archivos Terraform          ← local
2. terraform init && terraform apply             ← local (crea VM + red)
3. El startup script se ejecuta automáticamente  ← en la VM
4. Configurar registro DNS vpn.we-do.io          ← panel DNS we-do.io
5. Esperar propagación + verificar HTTPS         ← local
6. Verificar checklist de seguridad              ← SSH vía IAP
7. Crear primer grupo y cliente de prueba        ← panel web
8. Probar conexión VPN desde un dispositivo      ← cliente OpenVPN
```
