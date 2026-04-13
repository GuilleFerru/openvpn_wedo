"""
Pure helper functions for IP addressing and time/byte formatting.
No side-effects; no Flask dependencies.
"""

from datetime import datetime, timedelta
from config import VPN_SECOND_OCTET_START


def group_id_to_octets(group_num):
    """
    Group number → (second_octet, third_octet).
    Group 0 (Admin) → (8, 0), Group 255 → (8, 255)
    """
    return VPN_SECOND_OCTET_START, group_num


def octets_to_group_id(second_octet, third_octet):
    """
    (second_octet, third_octet) → group number.
    (8, X) → X
    """
    if second_octet != VPN_SECOND_OCTET_START:
        return 0
    return third_octet


def group_client_to_ip(group_num, client_num):
    """
    Group + client number → full IP.
    (1, 47) → '10.8.1.47'
    """
    return f"10.{VPN_SECOND_OCTET_START}.{group_num}.{client_num}"


def ip_to_group_client(ip_str):
    """
    IP string → (group_num, client_num).
    '10.8.1.47' → (1, 47)
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


def get_group_ip_range(group_num):
    """
    Group number → (start_ip, end_ip).
    1 → ('10.8.1.1', '10.8.1.254')
    """
    s = VPN_SECOND_OCTET_START
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
