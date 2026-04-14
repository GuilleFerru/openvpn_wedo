import os
import re
import logging
import subprocess

from flask import Blueprint, request, jsonify, send_file

from config import CLIENTS_DIR, VOLUME_NAME, CLIENTS_PER_GROUP, db_lock
from db import load_clients_db, save_clients_db
from network import group_client_to_ip, utc_to_argentina, format_bytes
from vpn import _write_ccd, _remove_ccd, _cleanup_client_files, _run_easyrsa_build, _export_ovpn_config
from .auth import login_required

logger = logging.getLogger('openvpn_admin.clients')

bp = Blueprint('clients', __name__)


@bp.route('/api/clients')
@login_required
def list_clients():
    db = load_clients_db()
    clients = []
    if os.path.exists(CLIENTS_DIR):
        for f in os.listdir(CLIENTS_DIR):
            if f.endswith('.ovpn'):
                name = f[:-5]
                info = db.get('clients', {}).get(name, {})
                clients.append({'name': name, 'group': info.get('group'), 'ip': info.get('ip')})
    return jsonify({'clients': sorted(clients, key=lambda x: (x['group'] or 'zzz', x['name']))})


@bp.route('/api/connected')
@login_required
def connected_clients():
    db = load_clients_db()
    clients = []

    # Collect rejected names to filter them out of the connected list
    rejected_names = set()
    try:
        result = subprocess.run(
            ['docker', 'logs', 'openvpn', '--tail', '200'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=10,
        )
        for line in result.stdout.split('\n'):
            if 'client-config-dir authentication failed' in line and 'common name' in line:
                m = re.search(r"common name '([^']+)'", line)
                if m:
                    rejected_names.add(m.group(1))
    except (subprocess.TimeoutExpired, OSError):
        pass

    try:
        result = subprocess.run(
            ['docker', 'exec', 'openvpn', 'cat', '/tmp/openvpn-status.log'],
            capture_output=True, text=True, timeout=10,
        )
        lines = result.stdout.strip().split('\n')

        in_client_list = False
        for line in lines:
            if line.startswith('Common Name,'):
                in_client_list = True
                continue
            if line.startswith('ROUTING TABLE'):
                break
            if in_client_list and ',' in line:
                parts = line.split(',')
                if len(parts) >= 4 and parts[0] != 'UNDEF' and parts[0] not in rejected_names:
                    name = parts[0]
                    info = db.get('clients', {}).get(name, {})
                    gid  = info.get('group')
                    grp  = db.get('groups', {}).get(gid, {}) if gid else {}
                    clients.append({
                        'name': name,
                        'real_ip': parts[1].split(':')[0],
                        'bytes_recv': format_bytes(int(parts[2])) if parts[2].isdigit() else parts[2],
                        'bytes_sent': format_bytes(int(parts[3])) if parts[3].isdigit() else parts[3],
                        'connected_since': utc_to_argentina(parts[4]) if len(parts) > 4 else 'N/A',
                        'vpn_ip': info.get('ip', 'Dinámica'),
                        'group_name': grp.get('name', ''),
                        'group_icon': grp.get('icon', ''),
                    })

        # Fill VPN IPs from routing table for clients without a static IP
        in_routing = False
        for line in lines:
            if line.startswith('Virtual Address,'):
                in_routing = True
                continue
            if line.startswith('GLOBAL STATS'):
                break
            if in_routing and ',' in line:
                parts = line.split(',')
                if len(parts) >= 2:
                    for c in clients:
                        if c['name'] == parts[1] and c['vpn_ip'] == 'Dinámica':
                            c['vpn_ip'] = parts[0]
                            break

    except Exception as e:
        logger.error('get_connected_clients_error', extra={'error': str(e)})

    return jsonify({'clients': clients})


@bp.route('/api/rejected')
@login_required
def rejected_clients():
    """Clients rejected due to missing CCD (ccd-exclusive mode)."""
    rejected = {}
    try:
        result = subprocess.run(
            ['docker', 'logs', 'openvpn', '--tail', '500'],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, timeout=15,
        )
        lines = result.stdout.strip().split('\n')

        for line in lines:
            if 'client-config-dir authentication failed' in line and 'common name' in line:
                m = re.search(r"common name '([^']+)'", line)
                if not m:
                    continue
                name = m.group(1)
                ts_m = re.search(r'^(\w+ \w+ \d+ \d+:\d+:\d+ \d+)', line)
                timestamp = ts_m.group(1) if ts_m else 'N/A'
                if name not in rejected or timestamp > rejected[name]['last_attempt']:
                    ip_m = re.search(r'(\d+\.\d+\.\d+\.\d+):', line)
                    rejected[name] = {
                        'name': name,
                        'real_ip': ip_m.group(1) if ip_m else 'N/A',
                        'last_attempt': utc_to_argentina(timestamp),
                        'reason': 'Sin archivo CCD',
                        'attempts': 1,
                    }

        # Second pass: count total attempts
        for line in lines:
            if 'client-config-dir authentication failed' in line:
                m = re.search(r"common name '([^']+)'", line)
                if m and m.group(1) in rejected:
                    rejected[m.group(1)]['attempts'] += 1

        # We counted once in the first pass and once here → divide by 2
        for name in rejected:
            rejected[name]['attempts'] = max(1, rejected[name]['attempts'] // 2)

    except Exception as e:
        logger.error('get_rejected_clients_error', extra={'error': str(e)})

    return jsonify({'clients': list(rejected.values())})


@bp.route('/api/create', methods=['POST'])
@login_required
def create_client():
    data     = request.json
    name     = data.get('name', '').strip()
    group_id = data.get('group', '')

    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    if not group_id:
        return jsonify({'success': False, 'error': 'Debe seleccionar un grupo'})
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        return jsonify({'success': False, 'error': 'Nombre inválido (solo letras, números, guiones)'})
    if len(name) > 64:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 64 caracteres)'})

    # Reserve IP atomically before touching the filesystem
    with db_lock:
        db = load_clients_db()
        group = db['groups'].get(group_id)
        if not group:
            return jsonify({'success': False, 'error': 'Grupo no existe'})

        next_client = group.get('next_client', 1)
        if next_client > CLIENTS_PER_GROUP:
            return jsonify({'success': False, 'error': 'Grupo lleno, no hay más IPs disponibles (máx 254 clientes)'})

        assigned_ip = group_client_to_ip(group.get('group_num', 0), next_client)
        db['groups'][group_id]['next_client'] = next_client + 1
        save_clients_db(db)

    try:
        _write_ccd(name, assigned_ip)

        returncode, err = _run_easyrsa_build(name)
        if returncode != 0:
            _remove_ccd(name)
            if 'already exists' in err:
                return jsonify({'success': False, 'error': 'Ya existe un cliente con ese nombre'})
            return jsonify({'success': False, 'error': 'Error generando certificado'})

        ovpn_content = _export_ovpn_config(name)
        if ovpn_content is None:
            _remove_ccd(name)
            return jsonify({'success': False, 'error': 'Error exportando configuración'})

        os.makedirs(CLIENTS_DIR, exist_ok=True)
        with open(os.path.join(CLIENTS_DIR, f'{name}.ovpn'), 'w') as f:
            f.write(ovpn_content)

        with db_lock:
            db = load_clients_db()
            db['clients'][name] = {'group': group_id, 'ip': assigned_ip}
            save_clients_db(db)

        logger.info('client_created', extra={'client': name, 'group': group_id, 'ip': assigned_ip})
        return jsonify({'success': True, 'name': name, 'ip': assigned_ip, 'group': group_id})

    except subprocess.TimeoutExpired:
        _remove_ccd(name)
        return jsonify({'success': False, 'error': 'Timeout - la operación tardó demasiado'})
    except Exception as e:
        logger.error('create_client_error', extra={'client': name, 'error': str(e)})
        _remove_ccd(name)
        return jsonify({'success': False, 'error': 'Error inesperado al crear el cliente'})


@bp.route('/api/revoke', methods=['POST'])
@login_required
def revoke_client():
    data     = request.json
    name     = data.get('name', '').strip()

    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        return jsonify({'success': False, 'error': 'Nombre inválido'})

    try:
        result = subprocess.run(
            ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
             '-e', 'EASYRSA_BATCH=1', 'kylemanna/openvpn', 'ovpn_revokeclient', name, 'remove'],
            capture_output=True, timeout=120,
        )
        output  = (result.stdout.decode() + result.stderr.decode()).lower()
        success = 'revoking' in output or 'data base updated' in output

        if 'unable to find' in output or 'not found' in output:
            if os.path.exists(os.path.join(CLIENTS_DIR, f'{name}.ovpn')):
                _cleanup_client_files(name)
                return jsonify({'success': True})
            return jsonify({'success': False, 'error': 'Cliente no encontrado'})

        if 'bad decrypt' in output and not success:
            return jsonify({'success': False, 'error': 'Contraseña incorrecta'})

        if result.returncode != 0 and not success:
            return jsonify({'success': False, 'error': 'Error al revocar certificado'})

        _cleanup_client_files(name)

        try:
            subprocess.run(['docker', 'restart', 'openvpn'], timeout=30)
        except (subprocess.TimeoutExpired, OSError):
            pass

        logger.info('client_revoked', extra={'client': name})
        return jsonify({'success': True, 'message': 'Cliente revocado. OpenVPN reiniciado.'})

    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'Timeout - la operación tardó demasiado'})
    except Exception as e:
        logger.error('revoke_client_error', extra={'client': name, 'error': str(e)})
        return jsonify({'success': False, 'error': 'Error inesperado al revocar el cliente'})


@bp.route('/download/<name>')
@login_required
def download(name):
    name = re.sub(r'[^a-zA-Z0-9_-]', '', name)
    path = os.path.join(CLIENTS_DIR, f'{name}.ovpn')
    if os.path.exists(path):
        return send_file(path, as_attachment=True, download_name=f'{name}.ovpn')
    return 'Archivo no encontrado', 404
