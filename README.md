# WeDo VPN Manager

Sistema de administracion web para OpenVPN con aislamiento por grupos. Desplegado en GCP con Terraform.

## Funcionalidades

- Panel web (Flask + vanilla JS) para gestionar grupos y clientes VPN
- Aislamiento de red por grupo via iptables (admin ve todo, grupos no se ven entre si)
- Generacion y descarga de archivos `.ovpn` con certificados de 10 anios
- Monitoreo de conexiones activas y clientes rechazados en tiempo real
- Split tunnel: solo trafico VPN pasa por el tunel, internet no se afecta
- HTTPS automatico con Let's Encrypt via Traefik
- Persistencia total: datos sobreviven a destroy/recreate de la VM

## Arquitectura

```
Internet
  |
  +-- UDP 1194 ----------> openvpn (kylemanna/openvpn)
  |                            PKI en /mnt/vpn-data/openvpn
  |
  +-- TCP 80/443 ---------> traefik v3.4 (file provider)
  |                            |
  |                            +-> openvpn-admin:8080 (Flask + Gunicorn)
  |                                   |
  |                                   +-> docker-socket-proxy:2375
  |
  +-- TCP 22 (IAP only) --> sshd
```

**Red VPN:** `10.8.0.0/16` — topology subnet

| Grupo | Rango | Notas |
|-------|-------|-------|
| Admin (0) | 10.8.0.2 - 10.8.0.254 | Ve todos los grupos. `.1` reservado para server. |
| Grupo N | 10.8.N.1 - 10.8.N.254 | Solo ve su propio grupo. Hasta 255 grupos. |

## Stack

- **Backend:** Python 3.11, Flask, Gunicorn
- **Frontend:** Vanilla JS, CSS Clay Dark, Lucide icons, Outfit font
- **Infra:** GCP (Terraform), Docker Compose, Ubuntu 22.04
- **Reverse proxy:** Traefik v3.4 + Let's Encrypt (TLS-ALPN-01)
- **DB:** `clients.json` (archivo JSON en disco persistente)

## Estructura

```
openvpn_wedo/
+-- admin/
|   +-- app.py, config.py, db.py, vpn.py, network.py
|   +-- blueprints/         (auth, groups, clients)
|   +-- templates/           (index.html, login.html)
|   +-- static/css/          (style.css)
|   +-- static/js/           (app.js)
|   +-- Dockerfile
+-- infra/
|   +-- *.tf                 (providers, compute, network, firewall, iam, storage)
|   +-- scripts/startup.sh   (init VM, PKI, volumes, docker compose)
|   +-- Makefile             (ssh, logs, destroy-vm, apply)
+-- docs/
|   +-- deploy_status.md     (estado completo del deploy)
|   +-- ssh_acceso_vm.md     (guia SSH via IAP)
|   +-- palette.md           (paleta WeDo)
+-- docker-compose.yml
+-- traefik-dynamic.yml
+-- GUIA_USUARIO.md
+-- CLAUDE.md
```

## Deploy (GCP)

### Requisitos

- `gcloud` CLI autenticado con `roles/owner` en el proyecto
- Terraform >= 1.6
- Registro DNS para el dominio (A record -> IP estatica)

### Primer deploy

```bash
cd infra
cp terraform.tfvars.example terraform.tfvars
# Editar terraform.tfvars con passwords y dominio

terraform init
terraform apply
```

El `startup.sh` se ejecuta automaticamente: instala Docker, clona el repo, monta disco persistente, inicializa PKI (10 anios), levanta los 4 containers.

### Deploy de cambios

```bash
# En la VM:
cd /opt/vpn && sudo git pull && sudo docker compose up -d --build openvpn-admin
```

### Destroy / Recreate VM (datos persisten)

```bash
cd infra
make destroy-vm    # destruye solo la VM
make apply         # recrea la VM, reattacha disco persistente
```

### Clean start (wipe total)

```bash
# Wipe disco persistente:
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="sudo rm -rf /mnt/vpn-data/.initialized /mnt/vpn-data/openvpn/* /mnt/vpn-data/clients/* /mnt/vpn-data/ccd/* /mnt/vpn-data/letsencrypt/*"

cd infra && make destroy-vm && make apply
```

## Comandos utiles

```bash
# SSH a la VM
make ssh                    # desde infra/

# Logs
sudo docker compose -f /opt/vpn/docker-compose.yml logs -f openvpn-admin
sudo docker compose -f /opt/vpn/docker-compose.yml logs -f openvpn

# Verificar cert HTTPS
echo | openssl s_client -connect vpn.we-do.io:443 -servername vpn.we-do.io 2>/dev/null | openssl x509 -noout -dates

# Ver cert de un cliente
sudo docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  openssl x509 -in /etc/openvpn/pki/issued/<CLIENT>.crt -noout -dates
```

## Documentacion

- [Guia de usuario](GUIA_USUARIO.md) — uso del panel admin
- [Estado del deploy](docs/deploy_status.md) — estado completo, bugs resueltos, lessons learned
- [Acceso SSH](docs/ssh_acceso_vm.md) — comandos SSH via IAP

## Autor

**Guillermo Ferrucci** — WeDo IoT Solutions

---

© 2026 WeDo IoT Solutions
