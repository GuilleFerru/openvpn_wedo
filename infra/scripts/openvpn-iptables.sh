#!/bin/bash
# openvpn-iptables.sh — crea/rellena chain OPENVPN_FWD en el host.
#
# Ambos daemons openvpn corren con network_mode: host, asi que tun0 (daemon1,
# 10.8.0.0/16) y tun1 (daemon2, 10.9.0.0/16) viven en el netns del host y la
# FORWARD del host manda. Para NO romper Docker, ufw ni los otros containers,
# metemos todas las reglas en una chain custom enganchada a FORWARD — sin
# flushear FORWARD ni cambiar su policy.
#
# Idempotente: re-crea la chain limpia cada corrida. Debe correrse:
#   - al boot (systemd unit o cron @reboot)
#   - despues de cada 'docker compose up -d' si se reinicia docker
set -euo pipefail

CHAIN="OPENVPN_FWD"

# 1. Crear chain si no existe; si existe, flush para repoblar limpio.
if iptables -n -L "$CHAIN" >/dev/null 2>&1; then
  iptables -F "$CHAIN"
else
  iptables -N "$CHAIN"
fi

# 2. Enganchar chain a FORWARD una sola vez (posicion 1 para que matchee antes que Docker).
if ! iptables -C FORWARD -j "$CHAIN" 2>/dev/null; then
  iptables -I FORWARD 1 -j "$CHAIN"
fi

# 3. Conntrack — permitir respuestas establecidas.
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 4. Admin group (10.8.0.0/24) ve todo lo que salga por cualquier tun.
iptables -A "$CHAIN" -s 10.8.0.0/24 -o tun+ -j ACCEPT

# 5. Mismo grupo dentro de daemon1 (10.8.N.x <-> 10.8.N.x).
for i in $(seq 1 255); do
  iptables -A "$CHAIN" -s "10.8.$i.0/24" -d "10.8.$i.0/24" -j ACCEPT
done

# 6. Mismo grupo dentro de daemon2 (10.9.N.x <-> 10.9.N.x).
for i in $(seq 1 255); do
  iptables -A "$CHAIN" -s "10.9.$i.0/24" -d "10.9.$i.0/24" -j ACCEPT
done

# 7. Mismo grupo cross-daemon (10.8.N.x <-> 10.9.N.x).
for i in $(seq 1 255); do
  iptables -A "$CHAIN" -s "10.8.$i.0/24" -d "10.9.$i.0/24" -j ACCEPT
  iptables -A "$CHAIN" -s "10.9.$i.0/24" -d "10.8.$i.0/24" -j ACCEPT
done

# 8. Drop cualquier otro tun+ <-> tun+ (aisla grupos distintos).
iptables -A "$CHAIN" -i tun+ -o tun+ -j DROP

# NOTA: tun <-> eth0 (NAT a internet) NO matchea regla de DROP de arriba
# (requiere -i tun+ -o tun+), asi que sale por la chain sin match y vuelve
# a FORWARD donde Docker ya tiene sus reglas de NAT/masquerade.

echo "OPENVPN_FWD listo — $(iptables -S "$CHAIN" | wc -l) reglas."
