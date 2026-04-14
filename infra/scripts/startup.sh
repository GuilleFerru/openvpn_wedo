#!/bin/bash
# startup.sh — Se ejecuta automáticamente al crear la VM en GCE
# Lee configuración desde instance metadata (inyectada por Terraform)
set -euo pipefail

LOGFILE="/var/log/vpn-startup.log"
exec > >(tee -a "$LOGFILE") 2>&1
echo "=== VPN Startup Script — $(date) ==="

METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"
METADATA_HEADER="Metadata-Flavor: Google"

get_meta() {
  curl -sf -H "$METADATA_HEADER" "${METADATA_URL}/$1"
}

# --- 1. Leer configuración desde metadata ---
echo "[1/8] Leyendo metadata..."
ADMIN_PASSWORD=$(get_meta admin-password)
SECRET_KEY=$(get_meta secret-key)
DOMAIN=$(get_meta domain-name)
ACME_EMAIL=$(get_meta acme-email)
PUBLIC_IP=$(get_meta public-ip)
REPO_URL=$(get_meta repo-url)
BACKUP_BUCKET=$(get_meta backup-bucket)

echo "  Dominio: ${DOMAIN}"
echo "  IP pública: ${PUBLIC_IP}"
echo "  Bucket backups: ${BACKUP_BUCKET}"

# --- 2. Montar disco persistente ---
echo "[2/8] Montando disco persistente..."
DATA_DIR="/mnt/vpn-data"
DATA_DEVICE="/dev/disk/by-id/google-vpn-data"

mkdir -p "$DATA_DIR"

# Formatear solo si no tiene filesystem (primera vez)
if ! blkid "$DATA_DEVICE" &>/dev/null; then
  echo "  Formateando disco (primera vez)..."
  mkfs.ext4 -m 0 -F -E lazy_itable_init=0,lazy_journal_init=0 "$DATA_DEVICE"
fi

# Montar si no está montado
if ! mountpoint -q "$DATA_DIR"; then
  mount -o discard,defaults "$DATA_DEVICE" "$DATA_DIR"
  echo "  Disco montado en ${DATA_DIR}"
fi

# Agregar a fstab para que sobreviva reboots
if ! grep -q "$DATA_DEVICE" /etc/fstab; then
  echo "${DATA_DEVICE} ${DATA_DIR} ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  echo "  Agregado a fstab"
fi

# Crear estructura de directorios en disco persistente
mkdir -p "${DATA_DIR}/openvpn"
mkdir -p "${DATA_DIR}/clients"
mkdir -p "${DATA_DIR}/ccd"

# --- 3. Configurar firewall OS (ufw) — segunda capa tras GCP firewall rules ---
echo "[3/8] Configurando ufw..."
apt-get update -qq
apt-get install -y -qq ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH (solo llega desde IAP gracias al GCP firewall, pero lo declaramos igual)
ufw allow 80/tcp    # HTTP (Traefik — redirige a HTTPS)
ufw allow 443/tcp   # HTTPS (Traefik + Let's Encrypt)
ufw allow 1194/udp  # OpenVPN
ufw --force enable
echo "  ufw activo — puertos: 22/tcp, 80/tcp, 443/tcp, 1194/udp"

# --- 4. Instalar Docker ---
echo "[4/9] Instalando Docker..."
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq docker.io docker-compose-v2 git curl
  systemctl enable docker
  systemctl start docker
  echo "  Docker instalado"
else
  echo "  Docker ya instalado, saltando"
fi

# --- 5. Clonar repositorio ---
echo "[5/9] Clonando repositorio..."
APP_DIR="/opt/vpn"
if [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
  echo "  Repositorio clonado en ${APP_DIR}"
else
  cd "$APP_DIR"
  git pull origin master || true
  echo "  Repositorio actualizado"
fi
cd "$APP_DIR"

# --- 6. Symlinks: apuntar clients/ y ccd/ al disco persistente ---
echo "[6/9] Configurando symlinks al disco persistente..."
# Mover datos existentes si hay (primera vez desde boot disk)
if [ -d "${APP_DIR}/clients" ] && [ ! -L "${APP_DIR}/clients" ]; then
  cp -rn "${APP_DIR}/clients/"* "${DATA_DIR}/clients/" 2>/dev/null || true
  rm -rf "${APP_DIR}/clients"
fi
if [ -d "${APP_DIR}/ccd" ] && [ ! -L "${APP_DIR}/ccd" ]; then
  cp -rn "${APP_DIR}/ccd/"* "${DATA_DIR}/ccd/" 2>/dev/null || true
  rm -rf "${APP_DIR}/ccd"
fi

ln -sfn "${DATA_DIR}/clients" "${APP_DIR}/clients"
ln -sfn "${DATA_DIR}/ccd" "${APP_DIR}/ccd"
echo "  clients/ → ${DATA_DIR}/clients/"
echo "  ccd/ → ${DATA_DIR}/ccd/"

# El container openvpn-admin corre como appuser (UID 1000). Sin este chown,
# el worker de Flask lee pero no puede escribir clients.json ni archivos CCD,
# y la creación de clientes falla con PermissionError.
chown -R 1000:1000 "${DATA_DIR}/clients" "${DATA_DIR}/ccd"
echo "  Ownership de clients/ y ccd/ asignado a UID 1000 (appuser)"

# --- 7. Crear .env para producción ---
echo "[7/9] Configurando .env..."
cat > .env <<EOF
# Generado por startup.sh — $(date)
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SECRET_KEY=${SECRET_KEY}
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
BACKUP_BUCKET=${BACKUP_BUCKET}

# Producción: puertos estándar
HTTP_PORT=80
HTTPS_PORT=443
EOF
echo "  .env creado"

# --- 8. Crear volumen Docker sobre disco persistente ---
echo "[8/9] Preparando volumen Docker..."
# Eliminar volumen viejo si existe y apunta al boot disk
if docker volume inspect openvpn_openvpn_data &>/dev/null; then
  MOUNT=$(docker volume inspect openvpn_openvpn_data --format '{{ .Mountpoint }}')
  if [ "$MOUNT" != "${DATA_DIR}/openvpn" ]; then
    # Volumen apunta al boot disk — migrar datos y recrear
    echo "  Migrando volumen al disco persistente..."
    docker run --rm \
      -v openvpn_openvpn_data:/src:ro \
      -v "${DATA_DIR}/openvpn:/dst" \
      alpine sh -c "cp -a /src/. /dst/"
    docker volume rm openvpn_openvpn_data
  fi
fi

# Crear volumen apuntando al disco persistente
if ! docker volume inspect openvpn_openvpn_data &>/dev/null; then
  docker volume create \
    --driver local \
    --opt type=none \
    --opt device="${DATA_DIR}/openvpn" \
    --opt o=bind \
    openvpn_openvpn_data
  echo "  Volumen creado sobre ${DATA_DIR}/openvpn"
else
  echo "  Volumen ya existe en disco persistente"
fi

# Volumen persistente para certs Let's Encrypt de Traefik.
# Sin esto, cada destroy-vm pierde el acme.json y obliga a re-emitir cert
# (riesgo de pegarle al rate limit de LE: 5 duplicate certs/semana por dominio).
mkdir -p "${DATA_DIR}/letsencrypt"
chmod 700 "${DATA_DIR}/letsencrypt"
if ! docker volume inspect traefik_letsencrypt &>/dev/null; then
  docker volume create \
    --driver local \
    --opt type=none \
    --opt device="${DATA_DIR}/letsencrypt" \
    --opt o=bind \
    traefik_letsencrypt
  echo "  Volumen traefik_letsencrypt creado sobre ${DATA_DIR}/letsencrypt"
else
  echo "  Volumen traefik_letsencrypt ya existe"
fi

# --- 9. Inicializar PKI de OpenVPN (solo la primera vez) ---
echo "[9/9] Inicializando OpenVPN..."
INIT_MARKER="${DATA_DIR}/.initialized"
if [ ! -f "$INIT_MARKER" ]; then
  echo "  Primera ejecución — generando PKI (esto puede tardar ~60s)..."
  # -s 10.8.0.0/16: red del server (matchea el esquema de IPs del admin panel).
  # -e 'topology subnet': el CCD escribe 'ifconfig-push <ip> 255.255.0.0', que es
  #   formato subnet. Sin este flag, kylemanna deja topology net30 por default y
  #   el cliente rompe con "ifconfig addresses are not in the same /30 subnet".
  docker compose run --rm openvpn ovpn_genconfig \
    -u "udp://${PUBLIC_IP}" \
    -s "10.8.0.0/16" \
    -e "topology subnet"
  # ovpn_genconfig agrega "push block-outside-dns" por default.
  # En split-tunnel (sin redirect-gateway) eso bloquea DNS fuera del
  # túnel en Windows → parece "sin internet". Lo eliminamos post-gen.
  sed -i '/block-outside-dns/d' "${DATA_DIR}/openvpn/openvpn.conf"
  # EASYRSA_BATCH + EASYRSA_REQ_CN evitan que easyrsa build-ca prompte
  # el Common Name en modo non-TTY (error "Failed to build the CA").
  # EASYRSA_CERT_EXPIRE=3650: server cert dura 10 años. Crítico para
  # gateways remotos que no pueden reconfigurarse sin VPN.
  docker compose run --rm \
    -e EASYRSA_BATCH=1 \
    -e EASYRSA_REQ_CN="OpenVPN-CA" \
    -e EASYRSA_CERT_EXPIRE=3650 \
    openvpn ovpn_initpki nopass
  touch "$INIT_MARKER"
  echo "  PKI inicializada"
else
  echo "  PKI ya inicializada, saltando"
fi

# --- Levantar servicios ---
echo "Levantando servicios..."
docker compose up -d --build
echo "  Servicios levantados"

# --- Configurar backup diario (02:00 UTC) ---
echo "Configurando backup diario..."
cat > /etc/cron.d/vpn-backup <<CRON
0 2 * * * root cd /opt/vpn && BACKUP_BUCKET=${BACKUP_BUCKET} ./backup.sh >> /var/log/vpn-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/vpn-backup
echo "  Backup programado a las 02:00 UTC"

echo "=== Startup completo — $(date) ==="
echo "Panel admin: https://${DOMAIN}"
echo "VPN: udp://${PUBLIC_IP}:1194"
echo "Datos persistentes: ${DATA_DIR}"
echo "Backups GCS: gs://${BACKUP_BUCKET}"
