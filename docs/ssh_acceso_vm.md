# Acceso SSH a la VM `vpn-prod-vm`

Guía de comandos que **funcionan sin problemas** desde la máquina local (Windows + bash de Git) para operar la VM de OpenVPN en GCP.

**VM:** `vpn-prod-vm`
**Zona:** `us-central1-a`
**Proyecto:** `integracion-tagoio`
**Acceso:** solo por **IAP tunnel** (no hay SSH público, el firewall `vpn-prod-fw-iap-ssh` solo permite el rango `35.235.240.0/20`).

---

## 1. Pre-requisitos (una sola vez)

```bash
# Verificar que gcloud esté autenticado
gcloud auth list

# Si no estás logueado o expiró:
gcloud auth login

# Verificar proyecto activo
gcloud config get-value project
# Debe devolver: integracion-tagoio

# Si no, setearlo:
gcloud config set project integracion-tagoio
```

> **Nota sobre ADC:** Para operar Terraform necesitás además `gcloud auth application-default login`. Eso es distinto de `gcloud auth login` y no es requerido para SSH.

---

## 2. Abrir una sesión SSH interactiva

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap
```

Una vez dentro, usás `sudo` para todo lo que toque Docker o `/mnt/vpn-data/`.

> **Warning inofensivo:** En Windows aparece `Could not find platform independent libraries <prefix>`. Es un mensaje del Python embebido en gcloud, **no afecta la ejecución**. Ignorar.

---

## 3. Ejecutar un comando puntual (sin abrir shell)

Útil para scripting y diagnósticos rápidos.

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="sudo docker ps"
```

Para comandos con pipes, redirecciones o varios pasos, encadenar con `&&`:

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="sudo docker logs openvpn-admin --tail 50 && echo '---' && sudo docker logs traefik --tail 20"
```

---

## 4. Copiar archivos con `scp` vía IAP

```bash
# Subir archivo local → VM
gcloud compute scp ./local-file.txt vpn-prod-vm:/tmp/ \
  --zone=us-central1-a --tunnel-through-iap

# Bajar archivo VM → local
gcloud compute scp vpn-prod-vm:/tmp/remote-file.txt ./ \
  --zone=us-central1-a --tunnel-through-iap
```

---

## 5. Ver logs del arranque de la VM (serial port)

No requiere SSH, útil si la VM no está respondiendo.

```bash
gcloud compute instances get-serial-port-output vpn-prod-vm --zone=us-central1-a
```

Para seguir en vivo:
```bash
gcloud compute instances tail-serial-port-output vpn-prod-vm --zone=us-central1-a
```

---

## 6. Comandos frecuentes dentro de la VM

Una vez adentro (con `gcloud compute ssh ...`):

```bash
# Estado de contenedores
sudo docker ps
sudo docker compose -f /opt/vpn/docker-compose.yml ps

# Logs
sudo docker logs openvpn-admin --tail 100
sudo docker logs traefik --tail 50
sudo docker logs openvpn --tail 50

# Estado de la PKI
sudo ls -la /mnt/vpn-data/openvpn/pki/
sudo ls -la /mnt/vpn-data/openvpn/pki/issued/   # certs emitidos
sudo ls -la /mnt/vpn-data/clients/              # clients.json + .ovpn
sudo ls -la /mnt/vpn-data/ccd/                  # configs fijas por cliente

# Base de datos del panel
sudo cat /mnt/vpn-data/clients/clients.json

# Rebuild/restart de servicios
cd /opt/vpn
sudo docker compose up -d
sudo docker compose restart openvpn-admin
sudo docker compose down && sudo docker compose up -d

# Backup manual
sudo bash /opt/vpn/backup.sh
```

---

## 7. Atajos vía Makefile (desde `infra/`)

Si preferís no acordarte de los flags:

```bash
cd infra
make ssh        # equivale a: gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap
make logs       # serial port output
make destroy-vm # destruye SOLO la VM (preserva disco persistente y bucket)
```

---

## 8. Troubleshooting

### "Permission denied (publickey)"
gcloud genera/sube las keys solas al metadata de GCE la primera vez. Si falla:
```bash
gcloud compute config-ssh
```

### "ERROR: (gcloud.compute.ssh) Could not SSH into the instance"
Verificar que IAP esté permitido. La regla `vpn-prod-fw-iap-ssh` debe existir:
```bash
gcloud compute firewall-rules describe vpn-prod-fw-iap-ssh
```

### "invalid_rapt" al hacer `terraform apply`
Es un error de ADC, **no** de SSH. Re-autenticar:
```bash
gcloud auth application-default login
```

### La sesión cuelga al conectar
El túnel IAP puede tardar 5-10 segundos en establecerse la primera vez. Si cuelga >30s, cancelar con Ctrl+C y reintentar.

---

## 9. Resumen de un solo comando

Si querés el "copiar-pegar" minimalista para abrir shell en la VM:

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap
```

Eso es todo lo que necesitás el 95% del tiempo.
