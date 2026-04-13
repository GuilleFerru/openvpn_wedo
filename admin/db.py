"""
JSON database CRUD and group counter management.
"""

import os
import json
import logging

from config import (
    CLIENTS_DB, CLIENTS_DIR, db_lock,
    ADMIN_GROUP_NUM, CLIENTS_PER_GROUP,
)
from network import group_client_to_ip

logger = logging.getLogger('openvpn_admin.db')


# =============================================================================
# Core CRUD
# =============================================================================

def load_clients_db():
    """Load clients database from JSON file."""
    if os.path.exists(CLIENTS_DB):
        with open(CLIENTS_DB, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
            if 'groups' not in data:
                data = _create_default_db(data.get('clients', {}))
                save_clients_db(data)
            return data
    return _create_default_db({})


def _create_default_db(existing_clients=None):
    """Create default database structure."""
    return {
        'groups': {
            'admin': {
                'name': 'Administradores',
                'icon': '👑',
                'group_num': ADMIN_GROUP_NUM,
                # Admin arranca en .2: la .1 del octeto 0 (10.8.0.1) queda
                # reservada para el gateway del server OpenVPN.
                'next_client': 2,
                'can_see_all': True,
                'is_system': True,
            }
        },
        'clients': existing_clients or {},
        'next_group_num': 1,
    }


def save_clients_db(db):
    """Save clients database to JSON file."""
    os.makedirs(os.path.dirname(CLIENTS_DB), exist_ok=True)
    with open(CLIENTS_DB, 'w') as f:
        json.dump(db, f, indent=2, ensure_ascii=False)


# =============================================================================
# Group IP management
# =============================================================================

def get_next_ip_for_group(group_id):
    """
    Return the next available IP for a group without incrementing the counter.
    Returns None if the group is full or not found.
    """
    db = load_clients_db()
    group = db['groups'].get(group_id)
    if not group:
        return None
    next_client = group.get('next_client', 1)
    if next_client > CLIENTS_PER_GROUP:
        return None
    return group_client_to_ip(group.get('group_num', 0), next_client)


def confirm_ip_used(group_id, client_num):
    """
    Confirm a client number was used and advance the group counter.
    client_num is the fourth octet (1-254).
    """
    db = load_clients_db()
    group = db['groups'].get(group_id)
    if group and client_num >= group.get('next_client', 1):
        db['groups'][group_id]['next_client'] = client_num + 1
        save_clients_db(db)


def recalculate_group_counters():
    """Recalculate group counters based on actual .ovpn files on disk."""
    with db_lock:
        db = load_clients_db()

        # Discover clients that actually exist on disk
        existing_clients = set()
        if os.path.exists(CLIENTS_DIR):
            for f in os.listdir(CLIENTS_DIR):
                if f.endswith('.ovpn'):
                    existing_clients.add(f[:-5])

        # Remove DB entries with no corresponding .ovpn file
        clients_to_remove = [
            name for name in db.get('clients', {})
            if name not in existing_clients
        ]
        for name in clients_to_remove:
            del db['clients'][name]

        # Count highest used fourth-octet per group
        group_clients = {}
        for name, info in db.get('clients', {}).items():
            if name not in existing_clients:
                continue
            gid = info.get('group')
            if gid and gid in db['groups']:
                ip_str = info.get('ip', '')
                try:
                    octet = int(ip_str.split('.')[-1])
                    group_clients.setdefault(gid, []).append(octet)
                except (ValueError, IndexError):
                    pass

        # Reset next_client to max_used + 1 (o al mínimo del grupo si no hay clientes).
        # El grupo admin reserva la .1 para el gateway del server, así que su
        # mínimo es 2. Los demás grupos pueden usar .1 libremente.
        for gid in db['groups']:
            octets = group_clients.get(gid)
            min_client = 2 if db['groups'][gid].get('group_num') == ADMIN_GROUP_NUM else 1
            db['groups'][gid]['next_client'] = max(octets) + 1 if octets else min_client

        save_clients_db(db)
        return {
            'cleaned': clients_to_remove,
            'groups': {gid: len(ips) for gid, ips in group_clients.items()},
        }
