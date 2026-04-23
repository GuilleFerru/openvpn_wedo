import os
import re
import logging
import subprocess

from flask import Blueprint, request, jsonify, send_file

from config import (
    CLIENTS_DIR, VOLUME_NAME, CLIENTS_PER_GROUP, db_lock,
    DAEMON_CONFIG, MODEL_TO_DAEMON, DEFAULT_MODEL,
)
from db import load_clients_db, save_clients_db
from extensions import limiter
from network import group_client_to_ip, utc_to_argentina, format_bytes
from vpn import (
    _write_ccd, _remove_ccd, _remove_ccd_anywhere, _cleanup_client_files,
    _run_easyrsa_build, _export_ovpn_config, reload_all_daemons,
)
from .auth import login_required

logger = logging.getLogger('openvpn_admin.clients')

bp = Blueprint('clients', __name__)


def _client_info_with_daemon(db, name):
    """Helper: devuelve dict enriquecido con model+daemon defaulted."""
    info = db.get('clients', {}).get(name, {}) or {}
    return {
        'group':  info.get('group'),
        'ip':     info.get('ip'),
        'model':  info.get('model', DEFAULT_MODEL),
        'daemon': info.get('daemon', 'classic'),
    }


@bp.route('/api/clients')
@login_required
def list_clients():
    db = load_clients_db()
    clients = []
    if os.path.exists(CLIENTS_DIR):
        for f in os.listdir(CLIENTS_DIR):
            if f.endswith('.ovpn'):
                name = f[:-5]
                info = _client_info_with_daemon(db, name)
                clients.append({
                    'name':   name,
                    'group':  info['group'],
                    'ip':     info['ip'],
                    'model':  info['model'],
                    'daemon': info['daemon'],
                })
    return jsonify({'clients': sorted(clients, key=lambda x: (x['group'] or 'zzz', x['name']))})


def _collect_rejected_names():
    """Recoge CNs rechazados por CCD-missing de AMBOS daemons."""
    rejected = set()
    for daemon_cfg in DAEMON_CONFIG.values():
        container = daemon_cfg['container']
        try:
            result = subprocess.run(
                ['docker', 'logs', container, '--tail', '200'],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, timeout=10,
            )
            for line in result.stdout.split('\n'):
                if 'client-config-dir authentication failed' in line and 'common name' in line:
                    m = re.search(r"common name '([^']+)'", line)
                    if m:
                        rejected.add(m.group(1))
        except (subprocess.TimeoutExpired, OSError):
            continue
    return rejected


def _parse_status_log(container, daemon_name, rejected_names, db):
    """Lee /tmp/openvpn-status.log del container y devuelve list de clientes."""
    clients = []
    try:
        result = subprocess.run(
            ['docker', 'exec', container, 'cat', '/tmp/openvpn-status.log'],
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
                    info = _client_info_with_daemon(db, name)
                    gid  = info['group']
                    grp  = db.get('groups', {}).get(gid, {}) if gid else {}
                    clients.append({
                        'name': name,
                        'real_ip': parts[1].split(':')[0],
                        'bytes_recv': format_bytes(int(parts[2])) if parts[2].isdigit() else parts[2],
                        'bytes_sent': format_bytes(int(parts[3])) if parts[3].isdigit() else parts[3],
                        'connected_since': utc_to_argentina(parts[4]) if len(parts) > 4 else 'N/A',
                        'vpn_ip': info['ip'] or 'Dinámica',
                        'group_name': grp.get('name', ''),
                        'group_icon': grp.get('icon', ''),
                        'model':  info['model'],
                        'daemon': daemon_name,
                    })

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
        logger.error('parse_status_log_error', extra={'daemon': daemon_name, 'error': str(e)})
    return clients


@bp.route('/api/connected')
@login_required
def connected_clients():
    db = load_clients_db()
    rejected_names = _collect_rejected_names()

    clients = []
    for daemon_name, cfg in DAEMON_CONFIG.items():
        clients.extend(_parse_status_log(cfg['container'], daemon_name, rejected_names, db))

    return jsonify({'clients': clients})


@bp.route('/api/rejected')
@login_required
def rejected_clients():
    """Clients rejected due to missing CCD (ambos daemons)."""
    rejected = {}
    for daemon_name, cfg in DAEMON_CONFIG.items():
        container = cfg['container']
        try:
            result = subprocess.run(
                ['docker', 'logs', container, '--tail', '500'],
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
                            'daemon': daemon_name,
                        }

            for line in lines:
                if 'client-config-dir authentication failed' in line:
                    m = re.search(r"common name '([^']+)'", line)
                    if m and m.group(1) in rejected:
                        rejected[m.group(1)]['attempts'] += 1

        except Exception as e:
            logger.error('get_rejected_clients_error', extra={'daemon': daemon_name, 'error': str(e)})

    # Dividimos por 2 (una vez el first pass conta y la otra el second pass)
    for name in rejected:
        rejected[name]['attempts'] = max(1, rejected[name]['attempts'] // 2)

    return jsonify({'clients': list(rejected.values())})


@bp.route('/api/create', methods=['POST'])
@login_required
@limiter.limit('10 per minute')
def create_client():
    data     = request.json
    name     = data.get('name', '').strip()
    group_id = data.get('group', '')
    model    = data.get('model', DEFAULT_MODEL).strip()

    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    if not group_id:
        return jsonify({'success': False, 'error': 'Debe seleccionar un grupo'})
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        return jsonify({'success': False, 'error': 'Nombre inválido (solo letras, números, guiones)'})
    if len(name) > 64:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 64 caracteres)'})
    if model not in MODEL_TO_DAEMON:
        return jsonify({'success': False, 'error': f'Modelo desconocido: {model}'})

    daemon = MODEL_TO_DAEMON[model]
    counter_key = 'next_client' if daemon == 'classic' else 'next_client_modern'

    # Reserve IP atomically before touching the filesystem
    with db_lock:
        db = load_clients_db()
        group = db['groups'].get(group_id)
        if not group:
            return jsonify({'success': False, 'error': 'Grupo no existe'})

        next_client = group.get(counter_key, 1)
        if next_client > CLIENTS_PER_GROUP:
            return jsonify({'success': False, 'error': 'Grupo lleno en ese daemon, no hay más IPs (máx 254)'})

        assigned_ip = group_client_to_ip(group.get('group_num', 0), next_client, daemon)
        db['groups'][group_id][counter_key] = next_client + 1
        save_clients_db(db)

    try:
        _write_ccd(name, assigned_ip, daemon)

        returncode, err = _run_easyrsa_build(name)
        if returncode != 0:
            _remove_ccd(name, daemon)
            if 'already exists' in err:
                return jsonify({'success': False, 'error': 'Ya existe un cliente con ese nombre'})
            return jsonify({'success': False, 'error': 'Error generando certificado'})

        ovpn_content = _export_ovpn_config(name, daemon)
        if ovpn_content is None:
            _remove_ccd(name, daemon)
            return jsonify({'success': False, 'error': 'Error exportando configuración'})

        os.makedirs(CLIENTS_DIR, exist_ok=True)
        with open(os.path.join(CLIENTS_DIR, f'{name}.ovpn'), 'w') as f:
            f.write(ovpn_content)

        with db_lock:
            db = load_clients_db()
            db['clients'][name] = {
                'group':  group_id,
                'ip':     assigned_ip,
                'model':  model,
                'daemon': daemon,
            }
            save_clients_db(db)

        logger.info('client_created', extra={
            'client': name, 'group': group_id, 'ip': assigned_ip,
            'model': model, 'daemon': daemon,
        })
        return jsonify({
            'success': True, 'name': name, 'ip': assigned_ip,
            'group': group_id, 'model': model, 'daemon': daemon,
        })

    except subprocess.TimeoutExpired:
        _remove_ccd(name, daemon)
        return jsonify({'success': False, 'error': 'Timeout - la operación tardó demasiado'})
    except Exception as e:
        logger.error('create_client_error', extra={'client': name, 'error': str(e)})
        _remove_ccd(name, daemon)
        return jsonify({'success': False, 'error': 'Error inesperado al crear el cliente'})


@bp.route('/api/revoke', methods=['POST'])
@login_required
@limiter.limit('5 per minute')
def revoke_client():
    data     = request.json
    name     = data.get('name', '').strip()

    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        return jsonify({'success': False, 'error': 'Nombre inválido'})

    try:
        # easyrsa revoke corre contra el volumen compartido — sirve para ambos daemons.
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

        # SIGHUP a ambos daemons — recargan CRL sin restart completo (menos downtime).
        reload_all_daemons()

        logger.info('client_revoked', extra={'client': name})
        return jsonify({'success': True, 'message': 'Cliente revocado. CRL recargada en ambos daemons.'})

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
