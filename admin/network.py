"""
Pure helper functions for IP addressing and time/byte formatting.
No side-effects; no Flask dependencies.
"""

from datetime import datetime, timedelta
from config import VPN_SECOND_OCTET_START, DAEMON_CONFIG


def group_id_to_octets(group_num, daemon='classic'):
    """
    Group number → (second_octet, third_octet).
    daemon='classic': (8, N)  — daemon1 / UG67
    daemon='modern':  (9, N)  — daemon2 / UG63v2
    """
    return DAEMON_CONFIG[daemon]['second_octet'], group_num


def octets_to_group_id(second_octet, third_octet):
    """
    (second_octet, third_octet) → group number.
    Acepta 8.x (classic) y 9.x (modern). Si no matchea ninguno, admin (0).
    """
    classic = DAEMON_CONFIG['classic']['second_octet']
    modern  = DAEMON_CONFIG['modern']['second_octet']
    if second_octet not in (classic, modern):
        return 0
    return third_octet


def group_client_to_ip(group_num, client_num, daemon='classic'):
    """
    Group + client number → full IP.
    (1, 47, 'classic') → '10.8.1.47'
    (8, 1, 'modern')   → '10.9.8.1'
    """
    return f"10.{DAEMON_CONFIG[daemon]['second_octet']}.{group_num}.{client_num}"


def ip_to_group_client(ip_str):
    """
    IP string → (group_num, client_num).
    '10.8.1.47' → (1, 47), '10.9.8.1' → (8, 1)
    Returns (None, None) on parse error.
    """
    parts = ip_str.split('.')
    if len(parts) != 4:
        return None, None
    try:
        second = int(parts[1])
        third  = int(parts[2])
        fourth = int(parts[3])
        return octets_to_group_id(second, third), fourth
    except (ValueError, IndexError):
        return None, None


def ip_to_daemon(ip_str):
    """
    IP string → 'classic' o 'modern' basado en segundo octeto. Default classic.
    """
    parts = ip_str.split('.')
    if len(parts) < 2:
        return 'classic'
    try:
        second = int(parts[1])
    except ValueError:
        return 'classic'
    if second == DAEMON_CONFIG['modern']['second_octet']:
        return 'modern'
    return 'classic'


def get_group_ip_range(group_num, daemon='classic'):
    """
    Group number → (start_ip, end_ip) para el daemon pedido.
    (1, 'classic') → ('10.8.1.1', '10.8.1.254')
    (1, 'modern')  → ('10.9.1.1', '10.9.1.254')
    """
    s = DAEMON_CONFIG[daemon]['second_octet']
    return f"10.{s}.{group_num}.1", f"10.{s}.{group_num}.254"


def utc_to_argentina(utc_time_str):
    """Convert UTC time string to Argentina time (GMT-3)."""
    try:
        formats = [
            '%a %b %d %H:%M:%S %Y',
            '%Y-%m-%d %H:%M:%S',
        ]
        for fmt in formats:
            try:
                utc_dt = datetime.strptime(utc_time_str.strip(), fmt)
                return (utc_dt - timedelta(hours=3)).strftime('%a %b %d %H:%M:%S %Y')
            except ValueError:
                continue
        return utc_time_str
    except (TypeError, AttributeError):
        return utc_time_str


def format_bytes(b):
    """Format byte count to human-readable string."""
    if b < 1024:
        return f"{b}B"
    if b < 1024 * 1024:
        return f"{b / 1024:.1f}KB"
    return f"{b / (1024 * 1024):.1f}MB"
