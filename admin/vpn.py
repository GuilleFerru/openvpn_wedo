"""
Docker CLI wrappers for OpenVPN certificate and config operations.

Dos daemons: 'classic' (port 1194, subnet 10.8, /app/ccd) y 'modern' (port 1195,
subnet 10.9, /app/ccd-modern). PKI compartida via volumen openvpn_openvpn_data.
"""

import os
import re
import subprocess
import logging

from config import VOLUME_NAME, CLIENTS_DIR, LOCAL_SERVER_IP, db_lock, DAEMON_CONFIG
from db import load_clients_db, save_clients_db

logger = logging.getLogger('openvpn_admin.vpn')


def _ccd_dir_for(daemon):
    return DAEMON_CONFIG[daemon]['ccd_dir']


def _remove_ccd(name, daemon='classic'):
    """Remove CCD file del daemon especificado."""
    path = os.path.join(_ccd_dir_for(daemon), name)
    if os.path.exists(path):
        os.remove(path)


def _remove_ccd_anywhere(name):
    """Remove CCD del cliente en ambos daemons (defensivo)."""
    for daemon in DAEMON_CONFIG:
        _remove_ccd(name, daemon)


def _cleanup_client_files(name):
    """Remove .ovpn file, CCD file (ambos daemons), y DB entry."""
    ovpn = os.path.join(CLIENTS_DIR, f'{name}.ovpn')
    if os.path.exists(ovpn):
        os.remove(ovpn)
    with db_lock:
        db = load_clients_db()
        if name in db.get('clients', {}):
            del db['clients'][name]
            save_clients_db(db)
    _remove_ccd_anywhere(name)


def _write_ccd(name, assigned_ip, daemon='classic'):
    """Write CCD file con static IP en el dir del daemon correspondiente."""
    ccd_dir = _ccd_dir_for(daemon)
    os.makedirs(ccd_dir, mode=0o755, exist_ok=True)
    os.chmod(ccd_dir, 0o755)
    ccd_path = os.path.join(ccd_dir, name)
    with open(ccd_path, 'w') as f:
        f.write(f'ifconfig-push {assigned_ip} 255.255.0.0\n')
    os.chmod(ccd_path, 0o644)


def _run_easyrsa_build(name):
    """
    Build client certificate via easyrsa inside the OpenVPN container.
    PKI compartida — correr contra cualquiera de los 2 daemons da el mismo cert.
    Certs duran 10 anios (3650 dias) para evitar perder acceso a gateways
    remotos sin reconfig.
    Returns (returncode, stderr_lower).
    """
    result = subprocess.run(
        ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
         '-e', 'EASYRSA_CERT_EXPIRE=3650',
         'kylemanna/openvpn', 'easyrsa', 'build-client-full', name, 'nopass'],
        capture_output=True, timeout=120,
    )
    return result.returncode, result.stderr.decode().lower()


def _export_ovpn_config(name, daemon='classic'):
    """
    Export .ovpn config para el daemon pedido.
    - classic: puerto 1194 (comp-lzo inserted por ovpn_getclient)
    - modern:  puerto 1195, remove comp-lzo (UG63v2 rechaza el parametro)

    Si LOCAL_SERVER_IP esta set, agrega remote dual (primero local, despues publico).
    Returns config string, o None on failure.
    """
    result = subprocess.run(
        ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
         'kylemanna/openvpn', 'ovpn_getclient', name],
        capture_output=True, timeout=30,
    )
    if result.returncode != 0:
        return None
    content = result.stdout.decode()
    # ovpn_getclient inyecta "redirect-gateway def1" por default (full tunnel).
    # Lo removemos: solo tráfico hacia la red VPN debe ir por el túnel (split tunnel).
    # Sin esto, el cliente pierde internet porque todo el tráfico pasa por el VPN.
    content = re.sub(r'redirect-gateway.*\n?', '', content)

    port = DAEMON_CONFIG[daemon]['port']
    if port != 1194:
        # ovpn_getclient hardcodea el puerto del server principal en el remote line.
        # Lo reescribimos al puerto del daemon destino.
        content = re.sub(
            r'(remote \S+) 1194 (\S+)',
            rf'\1 {port} \2',
            content,
        )

    if daemon == 'modern':
        # UG63v2 con firmware OpenVPN 2.6 rechaza 'comp-lzo' con Options error.
        # Removemos la directiva y toleramos si aparece por otra ruta.
        content = re.sub(r'^comp-lzo.*\n?', '', content, flags=re.MULTILINE)
        # Ignore-unknown-option + allow-compression: parche defensivo por si algun
        # firmware intermedio envia comp-lzo en PUSH_REPLY (plan §1.2 item 4).
        content = 'ignore-unknown-option comp-lzo\nallow-compression yes\n' + content

    if LOCAL_SERVER_IP:
        content = re.sub(
            r'remote (\S+) (\d+) (\S+)',
            f'remote {LOCAL_SERVER_IP} \\2 \\3\nremote \\1 \\2 \\3',
            content,
            count=1,
        )
    return content


def _signal_daemon(daemon, signal='HUP'):
    """Envia signal al container del daemon (SIGHUP para reload CRL)."""
    container = DAEMON_CONFIG[daemon]['container']
    try:
        subprocess.run(
            ['docker', 'kill', '-s', signal, container],
            capture_output=True, timeout=10,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.warning('signal_daemon_failed', extra={'daemon': daemon, 'signal': signal, 'error': str(e)})


def reload_all_daemons():
    """SIGHUP a todos los daemons — para que releean CRL tras revoke."""
    for daemon in DAEMON_CONFIG:
        _signal_daemon(daemon, 'HUP')
