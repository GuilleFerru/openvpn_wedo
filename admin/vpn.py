"""
Docker CLI wrappers for OpenVPN certificate and config operations.
"""

import os
import re
import subprocess
import logging

from config import VOLUME_NAME, CLIENTS_DIR, CCD_DIR, LOCAL_SERVER_IP, db_lock
from db import load_clients_db, save_clients_db

logger = logging.getLogger('openvpn_admin.vpn')


def _remove_ccd(name):
    """Remove CCD file for a client if it exists."""
    path = os.path.join(CCD_DIR, name)
    if os.path.exists(path):
        os.remove(path)


def _cleanup_client_files(name):
    """Remove .ovpn file, CCD file, and DB entry for a client."""
    ovpn = os.path.join(CLIENTS_DIR, f'{name}.ovpn')
    if os.path.exists(ovpn):
        os.remove(ovpn)
    with db_lock:
        db = load_clients_db()
        if name in db.get('clients', {}):
            del db['clients'][name]
            save_clients_db(db)
    _remove_ccd(name)


def _write_ccd(name, assigned_ip):
    """Write CCD file with static IP assignment."""
    os.makedirs(CCD_DIR, mode=0o755, exist_ok=True)
    os.chmod(CCD_DIR, 0o755)
    ccd_path = os.path.join(CCD_DIR, name)
    with open(ccd_path, 'w') as f:
        f.write(f'ifconfig-push {assigned_ip} 255.255.0.0\n')
    os.chmod(ccd_path, 0o644)


def _run_easyrsa_build(name):
    """
    Build client certificate via easyrsa inside the OpenVPN container.
    Certs last 10 years (3650 days) to avoid losing access to remote
    gateways that can't be reconfigured without VPN connectivity.
    Returns (returncode, stderr_lower).
    """
    result = subprocess.run(
        ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
         '-e', 'EASYRSA_CERT_EXPIRE=3650',
         'kylemanna/openvpn', 'easyrsa', 'build-client-full', name, 'nopass'],
        capture_output=True, timeout=120,
    )
    return result.returncode, result.stderr.decode().lower()


def _export_ovpn_config(name):
    """
    Export .ovpn config for a client.
    If LOCAL_SERVER_IP is configured, prepends it as a first remote (dual-remote).
    Returns config string, or None on failure.
    """
    result = subprocess.run(
        ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
         'kylemanna/openvpn', 'ovpn_getclient', name],
        capture_output=True, timeout=30,
    )
    if result.returncode != 0:
        return None
    content = result.stdout.decode()
    if LOCAL_SERVER_IP:
        content = re.sub(
            r'remote (\S+) (\d+) (\S+)',
            f'remote {LOCAL_SERVER_IP} \\2 \\3\nremote \\1 \\2 \\3',
            content,
            count=1,
        )
    return content
