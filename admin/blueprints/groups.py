import os
import re
import logging

from flask import Blueprint, request, jsonify

from config import CLIENTS_DIR, MAX_GROUPS, CLIENTS_PER_GROUP, db_lock
from db import load_clients_db, save_clients_db, recalculate_group_counters
from network import get_group_ip_range
from .auth import login_required

logger = logging.getLogger('openvpn_admin.groups')

bp = Blueprint('groups', __name__)


@bp.route('/api/groups', methods=['GET'])
@login_required
def get_groups():
    db = load_clients_db()
    groups  = db.get('groups', {})
    clients = db.get('clients', {})

    # Clientes por grupo y por daemon — soporta grupos con UG67+UG63 mezclados.
    counts_by_daemon = {}
    for name, info in clients.items():
        gid = info.get('group')
        daemon = info.get('daemon', 'classic')
        if gid and os.path.exists(f'{CLIENTS_DIR}/{name}.ovpn'):
            c = counts_by_daemon.setdefault(gid, {'classic': 0, 'modern': 0})
            c[daemon] = c.get(daemon, 0) + 1

    for gid, g in groups.items():
        group_num = g.get('group_num', 0)
        c_start, c_end = get_group_ip_range(group_num, 'classic')
        m_start, m_end = get_group_ip_range(group_num, 'modern')
        counts = counts_by_daemon.get(gid, {'classic': 0, 'modern': 0})

        # Campos legacy (start_ip/end_ip, capacity, client_count) — UI vieja.
        g['start_ip']      = c_start
        g['end_ip']        = c_end
        g['capacity']      = CLIENTS_PER_GROUP
        g['client_count']  = counts['classic'] + counts['modern']

        # Campos per-daemon — UI nueva puede mostrar breakdown.
        g['classic_start'] = c_start
        g['classic_end']   = c_end
        g['modern_start']  = m_start
        g['modern_end']    = m_end
        g['classic_count'] = counts['classic']
        g['modern_count']  = counts['modern']

    return jsonify({'groups': groups})


@bp.route('/api/groups', methods=['POST'])
@login_required
def create_group():
    data = request.json
    name = data.get('name', '').strip()
    icon = data.get('icon', 'AB')[:2].upper()
    if not re.match(r'^[A-Z]{1,2}$', icon):
        icon = 'AB'

    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    if len(name) > 50:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 50 caracteres)'})

    with db_lock:
        db = load_clients_db()

        group_id = re.sub(r'[^a-z0-9]', '-', name.lower()).strip('-')
        group_id = re.sub(r'-+', '-', group_id) or f'grupo-{len(db["groups"])}'

        if group_id in db['groups']:
            return jsonify({'success': False, 'error': 'Ya existe un grupo con ese nombre'})

        next_group_num = db.get('next_group_num', 1)
        if next_group_num > MAX_GROUPS:
            return jsonify({'success': False, 'error': 'No hay más grupos disponibles (máx 255)'})

        start_ip, end_ip = get_group_ip_range(next_group_num)

        db['groups'][group_id] = {
            'name': name,
            'icon': icon,
            'group_num': next_group_num,
            'next_client': 1,
            'can_see_all': False,
            'is_system': False,
        }
        db['next_group_num'] = next_group_num + 1
        save_clients_db(db)

    return jsonify({
        'success': True,
        'group_id': group_id,
        'group_num': next_group_num,
        'start_ip': start_ip,
        'end_ip': end_ip,
        'capacity': CLIENTS_PER_GROUP,
    })


@bp.route('/api/groups/<group_id>', methods=['PUT'])
@login_required
def update_group(group_id):
    data = request.json
    name = data.get('name', '').strip()
    icon = data.get('icon', 'AB')[:2].upper()
    if not re.match(r'^[A-Z]{1,2}$', icon):
        icon = 'AB'

    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    if len(name) > 50:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 50 caracteres)'})

    with db_lock:
        db = load_clients_db()
        if group_id not in db['groups']:
            return jsonify({'success': False, 'error': 'Grupo no encontrado'})
        g = db['groups'][group_id]
        if g.get('is_system') or g.get('can_see_all'):
            return jsonify({'success': False, 'error': 'No se puede editar el grupo de administradores'})
        g['name'] = name
        g['icon'] = icon
        save_clients_db(db)

    return jsonify({'success': True})


@bp.route('/api/next-group-range', methods=['GET'])
@login_required
def get_next_group_range():
    db = load_clients_db()
    next_group_num = db.get('next_group_num', 1)

    if next_group_num > MAX_GROUPS:
        return jsonify({'available': False, 'reason': 'Máximo de grupos alcanzado (255)'})

    c_start, c_end = get_group_ip_range(next_group_num, 'classic')
    m_start, m_end = get_group_ip_range(next_group_num, 'modern')
    return jsonify({
        'available': True,
        'group_num': next_group_num,
        'start_ip':  c_start,   # legacy — clasicca por default
        'end_ip':    c_end,
        'classic_start': c_start, 'classic_end': c_end,
        'modern_start':  m_start, 'modern_end':  m_end,
        'capacity': CLIENTS_PER_GROUP,
        'remaining_groups': MAX_GROUPS - next_group_num + 1,
    })


@bp.route('/api/recalculate', methods=['POST'])
@login_required
def api_recalculate():
    result = recalculate_group_counters()
    return jsonify({'success': True, 'message': 'Contadores recalculados', 'details': result})
