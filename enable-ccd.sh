#!/bin/bash
# Script para habilitar Client Config Directory (CCD) con modo exclusivo
# Esto permite asignar IPs fijas a clientes específicos
# SOLO clientes con archivo CCD pueden conectarse (ccd-exclusive)

set -e

VOLUME_NAME="openvpn_openvpn_data"

echo "=== Configurando OpenVPN con CCD exclusivo ==="
echo ""
echo "Esto asegura que SOLO clientes con archivo CCD pueden conectarse"
echo ""

# Verificar si client-config-dir ya está habilitado
if docker run -v $VOLUME_NAME:/etc/openvpn --rm kylemanna/openvpn cat /etc/openvpn/openvpn.conf | grep -q "client-config-dir"; then
    echo "✓ client-config-dir ya está habilitado"
else
    docker run -v $VOLUME_NAME:/etc/openvpn --rm kylemanna/openvpn sh -c 'echo "client-config-dir /etc/openvpn/ccd" >> /etc/openvpn/openvpn.conf'
    echo "✅ client-config-dir habilitado"
fi

# Verificar si ccd-exclusive ya está habilitado
# CRITICO: Esto impide que clientes sin CCD obtengan IP dinámica
if docker run -v $VOLUME_NAME:/etc/openvpn --rm kylemanna/openvpn cat /etc/openvpn/openvpn.conf | grep -q "ccd-exclusive"; then
    echo "✓ ccd-exclusive ya está habilitado"
else
    docker run -v $VOLUME_NAME:/etc/openvpn --rm kylemanna/openvpn sh -c 'echo "ccd-exclusive" >> /etc/openvpn/openvpn.conf'
    echo "✅ ccd-exclusive habilitado - clientes sin CCD NO pueden conectarse"
fi

# NOTA: No usamos ifconfig-pool explícito porque --server ya lo define implícitamente
# La protección real viene de ccd-exclusive: sin archivo CCD = sin conexión

# Crear directorio ccd local si no existe
mkdir -p ./ccd

echo ""
echo "Reiniciando OpenVPN..."
docker compose restart openvpn

echo ""
echo "=== Configuración completada ==="
echo ""
echo "✅ CCD exclusivo habilitado"
echo "✅ Clientes sin archivo CCD NO pueden conectarse"
echo ""
echo "NOTA: Subred 10.8.0.0/16 - 255 grupos x 254 clientes"
echo ""
echo "IMPORTANTE: Si hay clientes conectados sin CCD válido,"
echo "            serán desconectados al reiniciar OpenVPN."
