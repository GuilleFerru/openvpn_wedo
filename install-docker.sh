#!/bin/bash
# =============================================================================
# Script de instalación de Docker para Ubuntu
# Ejecutar con: sudo bash install-docker.sh
# =============================================================================

set -e

echo "=== Instalando Docker en Ubuntu ==="

# Actualizar paquetes
echo "Actualizando paquetes..."
apt update

# Instalar dependencias
echo "Instalando dependencias..."
apt install -y ca-certificates curl gnupg lsb-release git

# Agregar clave GPG de Docker
echo "Configurando repositorio Docker..."
mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Agregar repositorio Docker
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

# Instalar Docker
echo "Instalando Docker..."
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Agregar usuario al grupo docker
echo "Agregando usuario edciot al grupo docker..."
usermod -aG docker edciot

# Habilitar Docker al inicio
systemctl enable docker
systemctl start docker

echo ""
echo "=== Docker instalado correctamente ==="
echo "Versión de Docker:"
docker --version
echo "Versión de Docker Compose:"
docker compose version
echo ""
echo "IMPORTANTE: Cierra y vuelve a abrir la sesión SSH para que apliquen los permisos de grupo."
