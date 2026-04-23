"""
JSON database CRUD, group counter management, y migration schema v1 -> v2.

v1 schema (pre-2026-04-23):
  clients: {name: {group, ip}}
  groups:  {gid: {..., next_client}}

v2 schema (2026-04-23, 2 daemons):
  clients: {name: {group, ip, model, daemon}}
  groups:  {gid: {..., next_client, next_client_modern}}
  (next_client sigue siendo el contador classic — para backward compat)
"""

import os
import json
import logging

from config import (
    CLIENTS_DB, CLIENTS_DIR, CCD_DIR, CCD_DIR_MODERN, db_lock,
    ADMIN_GROUP_NUM, CLIENTS_PER_GROUP,
    DAEMON_CONFIG, DEFAULT_MODEL,
)
from network import group_client_to_ip

logger = logging.getLogger('openvpn_admin.db')


# =============================================================================
# Core CRUD
# =============================================================================

def load_clients_db():
    """Load clients database from JSON file (migra schema v1 -> v2 si hace falta)."""
    if os.path.exists(CLIENTS_DB):
        with open(CLIENTS_DB, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
            if 'groups' not in data:
                data = _create_default_db(data.get('clients', {}))
                save_clients_db(data)
            if _migrate_schema_v2(data):
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
                'next_client_modern': 1,
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
# Migration v1 -> v2 (two daemons)
# =============================================================================

def _migrate_schema_v2(db):
    """
    Backfill campos nuevos en schema v2. Idempotente. Devuelve True si mutó.

    Para clientes existentes detecta el daemon correcto leyendo CUAL CCD tiene
    su archivo (/app/ccd vs /app/ccd-modern). Si el CCD tiene una IP distinta
    a la guardada en db (ej WILO migrado manualmente), actualiza la IP.
    """
    changed = False

    for name, info in db.get('clients', {}).items():
        if 'daemon' not in info:
            daemon, actual_ip = _detect_client_daemon_from_ccd(name)
            info['daemon'] = daemon
            info['model'] = 'UG63v2' if daemon == 'modern' else DEFAULT_MODEL
            if actual_ip and actual_ip != info.get('ip'):
                logger.info(
                    'migration_ip_fix',
                    extra={'client': name, 'old_ip': info.get('ip'), 'new_ip': actual_ip}
                )
                info['ip'] = actual_ip
            changed = True
            logger.info(
                'migration_schema_v2',
                extra={'client': name, 'daemon': daemon, 'ip': info['ip']}
            )

    for gid, group in db.get('groups', {}).items():
        if 'next_client_modern' not in group:
            group['next_client_modern'] = 1
            changed = True

    return changed


def _detect_client_daemon_from_ccd(name):
    """Devuelve (daemon, ip_from_ccd) basado en donde exista el CCD file."""
    ccd_modern = os.path.join(CCD_DIR_MODERN, name)
    ccd_classic = os.path.join(CCD_DIR, name)
    if os.path.exists(ccd_modern):
        return 'modern', _ip_from_ccd(ccd_modern)
    if os.path.exists(ccd_classic):
        return 'classic', _ip_from_ccd(ccd_classic)
    return 'classic', None


def _ip_from_ccd(ccd_path):
    """Parse 'ifconfig-push X.X.X.X 255.255.0.0' y extrae la IP."""
    try:
        with open(ccd_path) as f:
            for line in f:
                if line.startswith('ifconfig-push '):
                    parts = line.split()
                    if len(parts) >= 2:
                        return parts[1]
    except OSError:
        pass
    return None


# =============================================================================
# Group IP management
# =============================================================================

def _counter_key(daemon):
    """Field name del contador para ese daemon."""
    return 'next_client' if daemon == 'classic' else 'next_client_modern'


def get_next_ip_for_group(group_id, daemon='classic'):
    """
    Return the next available IP for a group + daemon without incrementing.
    Returns None if the group is full or not found.
    """
    db = load_clients_db()
    group = db['groups'].get(group_id)
    if not group:
        return None
    next_client = group.get(_counter_key(daemon), 1)
    if next_client > CLIENTS_PER_GROUP:
        return None
    return group_client_to_ip(group.get('group_num', 0), next_client, daemon)


def confirm_ip_used(group_id, client_num, daemon='classic'):
    """
    Confirm a client number was used and advance the group+daemon counter.
    client_num is the fourth octet (1-254).
    """
    db = load_clients_db()
    group = db['groups'].get(group_id)
    if group:
        key = _counter_key(daemon)
        if client_num >= group.get(key, 1):
            db['groups'][group_id][key] = client_num + 1
            save_clients_db(db)


def recalculate_group_counters():
    """
    Recalculate counters (classic + modern) based on actual .ovpn files on disk.
    """
    with db_lock:
        db = load_clients_db()

        existing_clients = set()
        if os.path.exists(CLIENTS_DIR):
            for f in os.listdir(CLIENTS_DIR):
                if f.endswith('.ovpn'):
                    existing_clients.add(f[:-5])

        clients_to_remove = [
            name for name in db.get('clients', {})
            if name not in existing_clients
        ]
        for name in clients_to_remove:
            del db['clients'][name]

        # Para cada grupo, acumular octetos usados por daemon
        group_octets = {}  # gid -> {'classic': [octets], 'modern': [octets]}
        for name, info in db.get('clients', {}).items():
            if name not in existing_clients:
                continue
            gid = info.get('group')
            daemon = info.get('daemon', 'classic')
            if gid and gid in db['groups']:
                try:
                    octet = int(info.get('ip', '').split('.')[-1])
                    group_octets.setdefault(gid, {'classic': [], 'modern': []})[daemon].append(octet)
                except (ValueError, IndexError):
                    pass

        for gid in db['groups']:
            octets_by_daemon = group_octets.get(gid, {'classic': [], 'modern': []})
            # classic: admin reserva .1 (server gateway), demas arrancan en .1
            min_classic = 2 if db['groups'][gid].get('group_num') == ADMIN_GROUP_NUM else 1
            classic_octs = octets_by_daemon['classic']
            db['groups'][gid]['next_client'] = max(classic_octs) + 1 if classic_octs else min_classic
            # modern: arranca siempre en .1
            modern_octs = octets_by_daemon['modern']
            db['groups'][gid]['next_client_modern'] = max(modern_octs) + 1 if modern_octs else 1

        save_clients_db(db)
        return {
            'cleaned': clients_to_remove,
            'groups': {
                gid: {'classic': len(v['classic']), 'modern': len(v['modern'])}
                for gid, v in group_octets.items()
            },
        }
