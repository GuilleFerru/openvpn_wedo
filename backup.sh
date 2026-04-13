#!/bin/bash
# backup.sh — Backup OpenVPN PKI volume, clients.json, and CCD files
# Run from the project root (same directory as docker-compose.yml)
# Usage: ./backup.sh [backup_dir]
#   backup_dir defaults to ~/openvpn_backups

set -euo pipefail

BACKUP_BASE="${1:-$HOME/openvpn_backups}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_DIR="${BACKUP_BASE}/${TIMESTAMP}"
VOLUME_NAME="${VOLUME_NAME:-openvpn_openvpn_data}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "${BACKUP_DIR}"

echo "[backup] Starting backup to ${BACKUP_DIR}"

# 1. Export PKI volume as tar archive
echo "[backup] Exporting Docker volume ${VOLUME_NAME} ..."
docker run --rm \
    -v "${VOLUME_NAME}:/data:ro" \
    -v "${BACKUP_DIR}:/backup" \
    alpine \
    tar czf /backup/openvpn_data.tar.gz -C /data .
echo "[backup] Volume exported → ${BACKUP_DIR}/openvpn_data.tar.gz"

# 2. Backup clients.json
if [ -f "${SCRIPT_DIR}/clients/clients.json" ]; then
    cp "${SCRIPT_DIR}/clients/clients.json" "${BACKUP_DIR}/clients.json"
    echo "[backup] clients.json backed up"
else
    echo "[backup] WARNING: clients/clients.json not found, skipping"
fi

# 3. Backup CCD directory (fixed IPs per client)
if [ -d "${SCRIPT_DIR}/ccd" ]; then
    tar czf "${BACKUP_DIR}/ccd.tar.gz" -C "${SCRIPT_DIR}" ccd
    echo "[backup] CCD directory backed up → ${BACKUP_DIR}/ccd.tar.gz"
else
    echo "[backup] WARNING: ccd/ directory not found, skipping"
fi

# 4. Subir a GCS si BACKUP_BUCKET está configurado
if [ -n "${BACKUP_BUCKET:-}" ]; then
    echo "[backup] Subiendo a gs://${BACKUP_BUCKET}/${TIMESTAMP}/ ..."
    gsutil -m cp -r "${BACKUP_DIR}/" "gs://${BACKUP_BUCKET}/${TIMESTAMP}/"
    echo "[backup] Backup subido a GCS"
else
    echo "[backup] BACKUP_BUCKET no configurado, saltando subida a GCS"
fi

# 5. Remove local backups older than 30 days (GCS tiene su propia lifecycle policy de 90 días)
find "${BACKUP_BASE}" -maxdepth 1 -type d -mtime +30 -exec rm -rf {} + 2>/dev/null || true
echo "[backup] Removed local backups older than 30 days"

echo "[backup] Done. Backup stored at: ${BACKUP_DIR}"
echo "[backup] Files:"
ls -lh "${BACKUP_DIR}"
