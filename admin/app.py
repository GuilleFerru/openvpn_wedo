"""
OpenVPN Admin - API Server
Flask application for managing OpenVPN clients and groups
"""

from flask import Flask, render_template, request, send_file, jsonify, redirect, url_for, session
from functools import wraps
from datetime import datetime, timedelta
import subprocess
import os
import re
import secrets
import json

# =============================================================================
# Configuration
# =============================================================================

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', secrets.token_hex(32))

VOLUME_NAME = "openvpn_openvpn_data"
CLIENTS_DIR = "/app/clients"
CCD_DIR = "/app/ccd"
CLIENTS_DB = "/app/clients/clients.json"
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD', 'admin123')
LOCAL_SERVER_IP = os.environ.get('LOCAL_SERVER_IP', '172.28.20.206')

# =============================================================================
# Network Configuration - Subnet /16: 10.8.0.0 - 10.8.255.255 (65,536 IPs)
# =============================================================================
# New IP scheme:
#   - Admin:    Group 0  → 10.8.0.1 - 10.8.0.254 (254 admins)
#   - Group 1:             10.8.1.1 - 10.8.1.254 (254 clients)
#   - ...
#   - Group 255:           10.8.255.1 - 10.8.255.254
#
# Formula: Group N → third_octet = N. (Second octet always 8)
# =============================================================================

VPN_SECOND_OCTET_START = 8
VPN_SECOND_OCTET_END = 8     # Fixed at 8
CLIENTS_PER_GROUP = 254      # Clients 1-254
MAX_GROUPS = 255             # Groups 0-255
ADMIN_GROUP_NUM = 0          # Admin uses 10.8.0.x


# =============================================================================
# IP Helper Functions - New /16 Subnet Scheme
# =============================================================================

def group_id_to_octets(group_num):
    """
    Convert group number to (second_octet, third_octet).
    Group 0 (Admin) → (8, 0)
    Group 255 → (8, 255)
    """
    return VPN_SECOND_OCTET_START, group_num


def octets_to_group_id(second_octet, third_octet):
    """
    Convert (second_octet, third_octet) back to group number.
    (8, X) → X
    """
    if second_octet != VPN_SECOND_OCTET_START:
        return 0  # Default to admin/0 if octet doesn't match
    return third_octet


def group_client_to_ip(group_num, client_num):
    """
    Convert group number and client number (1-254) to full IP.
    Group 1, Client 47 → 10.8.1.47
    """
    return f"10.{VPN_SECOND_OCTET_START}.{group_num}.{client_num}"


def ip_to_group_client(ip_str):
    """
    Parse IP string to (group_num, client_num).
    '10.8.1.47' → (1, 47)
    """
    parts = ip_str.split('.')
    if len(parts) != 4:
        return None, None
    try:
        second = int(parts[1])
        third = int(parts[2])
        fourth = int(parts[3])
        group_num = octets_to_group_id(second, third)
        return group_num, fourth
    except:
        return None, None


def get_group_ip_range(group_num):
    """
    Get the IP range for a group as (start_ip, end_ip).
    Group 1 → ('10.8.1.1', '10.8.1.254')
    """
    second = VPN_SECOND_OCTET_START
    third = group_num
    start_ip = f"10.{second}.{third}.1"
    end_ip = f"10.{second}.{third}.254"
    return start_ip, end_ip


def utc_to_argentina(utc_time_str):
    """Convert UTC time string to Argentina time (GMT-3)"""
    try:
        # OpenVPN format: "Thu Jan 18 20:15:23 2026" or similar
        # Try common formats
        formats = [
            '%a %b %d %H:%M:%S %Y',
            '%Y-%m-%d %H:%M:%S',
            '%a %b %d %H:%M:%S %Y'
        ]
        for fmt in formats:
            try:
                utc_dt = datetime.strptime(utc_time_str.strip(), fmt)
                # Subtract 3 hours for Argentina (GMT-3)
                arg_dt = utc_dt - timedelta(hours=3)
                return arg_dt.strftime('%a %b %d %H:%M:%S %Y')
            except ValueError:
                continue
        return utc_time_str  # Return original if parsing fails
    except:
        return utc_time_str


# =============================================================================
# Database Functions
# =============================================================================

def load_clients_db():
    """Load clients database from JSON file"""
    if os.path.exists(CLIENTS_DB):
        with open(CLIENTS_DB, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
            if 'groups' not in data:
                data = _create_default_db(data.get('clients', {}))
                save_clients_db(data)
            return data
    return _create_default_db({})


def _create_default_db(existing_clients=None):
    """Create default database structure with new /12 subnet scheme"""
    start_ip, end_ip = get_group_ip_range(ADMIN_GROUP_NUM)
    return {
        'groups': {
            'admin': {
                'name': 'Administradores',
                'icon': '👑',
                'group_num': ADMIN_GROUP_NUM,  # Group 0 = 10.8.0.x
                'next_client': 1,  # Next client number (1-254)
                'can_see_all': True,
                'is_system': True
            }
        },
        'clients': existing_clients or {},
        'next_group_num': 1  # Next group number to assign (1-2047)
    }


def save_clients_db(db):
    """Save clients database to JSON file"""
    os.makedirs(os.path.dirname(CLIENTS_DB), exist_ok=True)
    with open(CLIENTS_DB, 'w') as f:
        json.dump(db, f, indent=2, ensure_ascii=False)


# =============================================================================
# Group Management Functions
# =============================================================================

def get_next_ip_for_group(group_id):
    """
    Get next available IP for a group (doesn't increment counter).
    Returns full IP string or None if group is full.
    """
    db = load_clients_db()
    group = db['groups'].get(group_id)
    if not group:
        return None
    
    group_num = group.get('group_num', 0)
    next_client = group.get('next_client', 1)
    
    if next_client > CLIENTS_PER_GROUP:  # > 254
        return None
    
    return group_client_to_ip(group_num, next_client)


def confirm_ip_used(group_id, client_num):
    """
    Confirm client number was used and update counter.
    client_num is the fourth octet (1-254).
    """
    db = load_clients_db()
    group = db['groups'].get(group_id)
    if group and client_num >= group.get('next_client', 1):
        db['groups'][group_id]['next_client'] = client_num + 1
        save_clients_db(db)


def recalculate_group_counters():
    """Recalculate group counters based on actual .ovpn files"""
    db = load_clients_db()
    
    # Get list of existing clients (actual .ovpn files)
    existing_clients = set()
    if os.path.exists(CLIENTS_DIR):
        for f in os.listdir(CLIENTS_DIR):
            if f.endswith('.ovpn'):
                existing_clients.add(f.replace('.ovpn', ''))
    
    # Clean up clients that no longer exist
    clients_to_remove = [
        name for name in db.get('clients', {}).keys() 
        if name not in existing_clients
    ]
    for client_name in clients_to_remove:
        del db['clients'][client_name]
    
    # Count actual clients per group
    group_clients = {}
    for client_name, client_info in db.get('clients', {}).items():
        if client_name in existing_clients:
            gid = client_info.get('group')
            if gid and gid in db['groups']:
                ip_str = client_info.get('ip', '')
                if ip_str:
                    try:
                        ip_octet = int(ip_str.split('.')[-1])
                        if gid not in group_clients:
                            group_clients[gid] = []
                        group_clients[gid].append(ip_octet)
                    except:
                        pass
    
    # Update next_client for each group based on highest used client number
    for gid, group in db['groups'].items():
        if gid in group_clients and group_clients[gid]:
            max_client = max(group_clients[gid])
            db['groups'][gid]['next_client'] = max_client + 1
        else:
            db['groups'][gid]['next_client'] = 1
    
    save_clients_db(db)
    return {
        'cleaned': clients_to_remove,
        'groups': {gid: len(ips) for gid, ips in group_clients.items()}
    }


# =============================================================================
# Authentication
# =============================================================================

def login_required(f):
    """Decorator to require login for routes"""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated_function


# =============================================================================
# Utility Functions
# =============================================================================

def format_bytes(b):
    """Format bytes to human readable string"""
    if b < 1024:
        return f"{b}B"
    elif b < 1024 * 1024:
        return f"{b/1024:.1f}KB"
    else:
        return f"{b/(1024*1024):.1f}MB"


# =============================================================================
# Routes - Authentication
# =============================================================================

@app.route('/login', methods=['GET', 'POST'])
def login():
    if session.get('logged_in'):
        return redirect(url_for('index'))
    error = None
    if request.method == 'POST':
        if request.form['password'] == ADMIN_PASSWORD:
            session['logged_in'] = True
            return redirect(url_for('index'))
        else:
            error = 'Contraseña incorrecta'
    return render_template('login.html', error=error)


@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('login'))


@app.route('/')
@login_required
def index():
    return render_template('index.html')


# =============================================================================
# Routes - Groups API
# =============================================================================

@app.route('/api/groups', methods=['GET'])
@login_required
def get_groups():
    db = load_clients_db()
    groups = db.get('groups', {})
    clients = db.get('clients', {})
    
    # Count actual clients per group
    client_count = {}
    for client_name, client_info in clients.items():
        gid = client_info.get('group')
        if gid:
            # Verify .ovpn file exists
            if os.path.exists(f'{CLIENTS_DIR}/{client_name}.ovpn'):
                client_count[gid] = client_count.get(gid, 0) + 1
    
    # Add readable IP fields and real client count for UI
    for gid, g in groups.items():
        group_num = g.get('group_num', 0)
        start_ip, end_ip = get_group_ip_range(group_num)
        g['start_ip'] = start_ip
        g['end_ip'] = end_ip
        g['capacity'] = CLIENTS_PER_GROUP
        g['client_count'] = client_count.get(gid, 0)
    
    return jsonify({'groups': groups})


@app.route('/api/groups', methods=['POST'])
@login_required
def create_group():
    data = request.json
    name = data.get('name', '').strip()
    icon = data.get('icon', '🏢')
    
    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    
    if len(name) > 50:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 50 caracteres)'})
    
    db = load_clients_db()
    
    # Generate group ID from name
    group_id = re.sub(r'[^a-z0-9]', '-', name.lower()).strip('-')
    group_id = re.sub(r'-+', '-', group_id)
    if not group_id:
        group_id = f'grupo-{len(db["groups"])}'
    
    if group_id in db['groups']:
        return jsonify({'success': False, 'error': 'Ya existe un grupo con ese nombre'})
    
    # Get next available group number (1-2047)
    next_group_num = db.get('next_group_num', 1)
    
    if next_group_num > MAX_GROUPS:
        return jsonify({'success': False, 'error': 'No hay más grupos disponibles (máx 255)'})
    
    # Calculate IP range for this group
    start_ip, end_ip = get_group_ip_range(next_group_num)
    
    db['groups'][group_id] = {
        'name': name,
        'icon': icon,
        'group_num': next_group_num,
        'next_client': 1,  # Start from client 1
        'can_see_all': False,
        'is_system': False
    }
    
    db['next_group_num'] = next_group_num + 1
    save_clients_db(db)
    
    return jsonify({
        'success': True, 
        'group_id': group_id, 
        'group_num': next_group_num,
        'start_ip': start_ip, 
        'end_ip': end_ip,
        'capacity': CLIENTS_PER_GROUP
    })


@app.route('/api/groups/<group_id>', methods=['PUT'])
@login_required
def update_group(group_id):
    data = request.json
    name = data.get('name', '').strip()
    icon = data.get('icon', '🏢')
    
    if not name:
        return jsonify({'success': False, 'error': 'Nombre requerido'})
    
    if len(name) > 50:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 50 caracteres)'})
    
    db = load_clients_db()
    
    if group_id not in db['groups']:
        return jsonify({'success': False, 'error': 'Grupo no encontrado'})
    
    # Don't allow editing admin group
    if db['groups'][group_id].get('is_system') or db['groups'][group_id].get('can_see_all'):
        return jsonify({'success': False, 'error': 'No se puede editar el grupo de administradores'})
    
    db['groups'][group_id]['name'] = name
    db['groups'][group_id]['icon'] = icon
    save_clients_db(db)
    
    return jsonify({'success': True})


@app.route('/api/next-group-range', methods=['GET'])
@login_required
def get_next_group_range():
    """Get info about the next available group."""
    db = load_clients_db()
    next_group_num = db.get('next_group_num', 1)
    
    if next_group_num > MAX_GROUPS:
        return jsonify({'available': False, 'reason': 'Máximo de grupos alcanzado (255)'})
    
    start_ip, end_ip = get_group_ip_range(next_group_num)
    
    return jsonify({
        'available': True,
        'group_num': next_group_num,
        'start_ip': start_ip,
        'end_ip': end_ip,
        'capacity': CLIENTS_PER_GROUP,
        'remaining_groups': MAX_GROUPS - next_group_num + 1
    })


@app.route('/api/recalculate', methods=['POST'])
@login_required
def api_recalculate():
    """Recalculate group counters based on actual clients"""
    result = recalculate_group_counters()
    return jsonify({'success': True, 'message': 'Contadores recalculados', 'details': result})


# =============================================================================
# Routes - Clients API
# =============================================================================

@app.route('/api/clients')
@login_required
def list_clients():
    clients = []
    db = load_clients_db()
    
    if os.path.exists(CLIENTS_DIR):
        for f in os.listdir(CLIENTS_DIR):
            if f.endswith('.ovpn'):
                name = f.replace('.ovpn', '')
                info = db.get('clients', {}).get(name, {})
                clients.append({
                    'name': name,
                    'group': info.get('group'),
                    'ip': info.get('ip')
                })
    
    return jsonify({'clients': sorted(clients, key=lambda x: (x['group'] or 'zzz', x['name']))})


@app.route('/api/connected')
@login_required
def connected_clients():
    clients = []
    db = load_clients_db()
    
    # First, get list of rejected clients to filter them out
    rejected_names = set()
    try:
        cmd = 'docker logs openvpn --tail 200 2>&1'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
        for line in result.stdout.split('\n'):
            if 'client-config-dir authentication failed' in line and 'common name' in line:
                match = re.search(r"common name '([^']+)'", line)
                if match:
                    rejected_names.add(match.group(1))
    except:
        pass
    
    try:
        cmd = 'docker exec openvpn cat /tmp/openvpn-status.log 2>/dev/null || echo ""'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
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
                if len(parts) >= 4 and parts[0] != 'UNDEF':
                    name = parts[0]
                    
                    # Skip rejected clients - they appear briefly during failed auth
                    if name in rejected_names:
                        continue
                    
                    info = db.get('clients', {}).get(name, {})
                    gid = info.get('group')
                    grp = db.get('groups', {}).get(gid, {}) if gid else {}
                    
                    clients.append({
                        'name': name,
                        'real_ip': parts[1].split(':')[0],
                        'bytes_recv': format_bytes(int(parts[2])) if parts[2].isdigit() else parts[2],
                        'bytes_sent': format_bytes(int(parts[3])) if parts[3].isdigit() else parts[3],
                        'connected_since': utc_to_argentina(parts[4]) if len(parts) > 4 else 'N/A',
                        'vpn_ip': info.get('ip', 'Dinámica'),
                        'group_name': grp.get('name', ''),
                        'group_icon': grp.get('icon', '')
                    })
        
        # Get VPN IPs from routing table
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
        print(f"Error getting connected clients: {e}")
    
    return jsonify({'clients': clients})


@app.route('/api/rejected')
@login_required
def rejected_clients():
    """Get list of clients rejected due to missing CCD (ccd-exclusive)"""
    rejected = {}
    
    try:
        # Get last 500 lines of OpenVPN logs
        cmd = 'docker logs openvpn --tail 500 2>&1'
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=15)
        lines = result.stdout.strip().split('\n')
        
        for line in lines:
            # Look for CCD auth failures
            if 'client-config-dir authentication failed' in line and 'common name' in line:
                # Extract client name
                match = re.search(r"common name '([^']+)'", line)
                if match:
                    name = match.group(1)
                    # Extract timestamp
                    ts_match = re.search(r'^(\w+ \w+ \d+ \d+:\d+:\d+ \d+)', line)
                    timestamp = ts_match.group(1) if ts_match else 'N/A'
                    
                    # Keep latest attempt per client
                    if name not in rejected or timestamp > rejected[name]['last_attempt']:
                        # Extract IP
                        ip_match = re.search(r'(\d+\.\d+\.\d+\.\d+):', line)
                        real_ip = ip_match.group(1) if ip_match else 'N/A'
                        
                        rejected[name] = {
                            'name': name,
                            'real_ip': real_ip,
                            'last_attempt': utc_to_argentina(timestamp),
                            'reason': 'Sin archivo CCD'
                        }
                        
                        # Count attempts
                        if 'attempts' in rejected.get(name, {}):
                            rejected[name]['attempts'] += 1
                        else:
                            rejected[name]['attempts'] = 1
        
        # Count total attempts per client
        for line in lines:
            if 'client-config-dir authentication failed' in line:
                match = re.search(r"common name '([^']+)'", line)
                if match and match.group(1) in rejected:
                    rejected[match.group(1)]['attempts'] = rejected.get(match.group(1), {}).get('attempts', 0) + 1
        
        # Divide by 2 because we counted twice (once in first loop, once in second)
        for name in rejected:
            rejected[name]['attempts'] = max(1, rejected[name]['attempts'] // 2)
                        
    except Exception as e:
        print(f"Error getting rejected clients: {e}")
    
    return jsonify({'clients': list(rejected.values())})


@app.route('/api/create', methods=['POST'])
@login_required
def create_client():
    data = request.json
    name = data.get('name', '').strip()
    password = data.get('password', '')
    group_id = data.get('group', '')
    
    # Validation
    if not name or not password:
        return jsonify({'success': False, 'error': 'Nombre y contraseña requeridos'})
    
    if not group_id:
        return jsonify({'success': False, 'error': 'Debe seleccionar un grupo'})
    
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        return jsonify({'success': False, 'error': 'Nombre inválido (solo letras, números, guiones)'})
    
    if len(name) > 64:
        return jsonify({'success': False, 'error': 'Nombre muy largo (máx 64 caracteres)'})
    
    db = load_clients_db()
    
    group = db['groups'].get(group_id)
    if not group:
        return jsonify({'success': False, 'error': 'Grupo no existe'})
    
    # get_next_ip_for_group now returns full IP string like "10.8.1.47"
    assigned_ip = get_next_ip_for_group(group_id)
    if assigned_ip is None:
        return jsonify({'success': False, 'error': 'Grupo lleno, no hay más IPs disponibles (máx 254 clientes)'})
    
    # Extract client number (fourth octet) for peer calculation
    _, client_num = ip_to_group_client(assigned_ip)
    group_num = group.get('group_num', 0)
    
    try:
        # Create CCD file for static IP
        # Peer IP calculation: if client is even, peer is +1; if odd, peer is -1
        os.makedirs(CCD_DIR, mode=0o755, exist_ok=True)
        # Ensure CCD dir is world-readable (OpenVPN runs as nobody)
        os.chmod(CCD_DIR, 0o755)
        
        ccd_path = f'{CCD_DIR}/{name}'
        with open(ccd_path, 'w') as f:
            # topology subnet format: ifconfig-push <IP> <NETMASK>
            f.write(f'ifconfig-push {assigned_ip} 255.255.0.0\n')
        os.chmod(ccd_path, 0o644)
        
        # Generate certificate (CA is nopass, no stdin needed)
        cmd = f'docker run -v {VOLUME_NAME}:/etc/openvpn --rm kylemanna/openvpn easyrsa build-client-full {name} nopass'
        result_cert = subprocess.run(cmd, shell=True, capture_output=True, timeout=120)
        stdout, stderr = result_cert.stdout, result_cert.stderr
        proc = result_cert  # For returncode check below
        
        if proc.returncode != 0:
            # Cleanup on failure
            if os.path.exists(f'{CCD_DIR}/{name}'):
                os.remove(f'{CCD_DIR}/{name}')
            
            err = stderr.decode().lower()
            if 'bad decrypt' in err or 'pass phrase' in err:
                return jsonify({'success': False, 'error': 'Contraseña de CA incorrecta'})
            if 'already exists' in err:
                return jsonify({'success': False, 'error': 'Ya existe un cliente con ese nombre'})
            return jsonify({'success': False, 'error': stderr.decode()[:200]})
        
        # Export .ovpn file
        cmd2 = f'docker run -v {VOLUME_NAME}:/etc/openvpn --rm kylemanna/openvpn ovpn_getclient {name}'
        result = subprocess.run(cmd2, shell=True, capture_output=True, timeout=30)
        
        if result.returncode != 0:
            # Cleanup CCD on failure
            if os.path.exists(f'{CCD_DIR}/{name}'):
                os.remove(f'{CCD_DIR}/{name}')
            return jsonify({'success': False, 'error': 'Error exportando configuración'})
        
        os.makedirs(CLIENTS_DIR, exist_ok=True)
        ovpn_content = result.stdout.decode()
        
        # Add local IP as primary remote for ALL clients
        # so they can connect from LAN (local first, public fallback)
        import re as re_mod
        ovpn_content = re_mod.sub(
            r'remote (\S+) (\d+) (\S+)',
            f'remote {LOCAL_SERVER_IP} \\2 \\3\nremote \\1 \\2 \\3',
            ovpn_content,
            count=1
        )
        
        with open(f'{CLIENTS_DIR}/{name}.ovpn', 'w') as f:
            f.write(ovpn_content)
        
        # Confirm client number was used (updates counter)
        confirm_ip_used(group_id, client_num)
        
        # Save to database
        db = load_clients_db()
        db['clients'][name] = {
            'group': group_id,
            'ip': assigned_ip
        }
        save_clients_db(db)
        
        return jsonify({'success': True, 'name': name, 'ip': assigned_ip, 'group': group_id})
        
    except subprocess.TimeoutExpired:
        # Cleanup CCD on timeout
        if os.path.exists(f'{CCD_DIR}/{name}'):
            os.remove(f'{CCD_DIR}/{name}')
        return jsonify({'success': False, 'error': 'Timeout - operación tardó demasiado'})
    except Exception as e:
        # Cleanup CCD on any error
        if os.path.exists(f'{CCD_DIR}/{name}'):
            os.remove(f'{CCD_DIR}/{name}')
        return jsonify({'success': False, 'error': str(e)})


@app.route('/api/revoke', methods=['POST'])
@login_required
def revoke_client():
    data = request.json
    name = data.get('name', '').strip()
    password = data.get('password', '')
    
    if not name or not password:
        return jsonify({'success': False, 'error': 'Nombre y contraseña requeridos'})
    
    if not re.match(r'^[a-zA-Z0-9_-]+$', name):
        return jsonify({'success': False, 'error': 'Nombre inválido'})
    
    try:
        cmd = f'docker run -v {VOLUME_NAME}:/etc/openvpn --rm -e EASYRSA_BATCH=1 kylemanna/openvpn ovpn_revokeclient {name} remove'
        result_rev = subprocess.run(cmd, shell=True, capture_output=True, timeout=120)
        stdout, stderr = result_rev.stdout, result_rev.stderr
        proc = result_rev  # For returncode check below
        
        output = (stdout.decode() + stderr.decode()).lower()
        success = 'revoking' in output or 'data base updated' in output
        
        if 'unable to find' in output or 'not found' in output:
            ovpn = f'{CLIENTS_DIR}/{name}.ovpn'
            if os.path.exists(ovpn):
                os.remove(ovpn)
                db = load_clients_db()
                if name in db.get('clients', {}):
                    del db['clients'][name]
                    save_clients_db(db)
                if os.path.exists(f'{CCD_DIR}/{name}'):
                    os.remove(f'{CCD_DIR}/{name}')
                return jsonify({'success': True})
            return jsonify({'success': False, 'error': 'Cliente no encontrado'})
        
        if 'bad decrypt' in output and not success:
            return jsonify({'success': False, 'error': 'Contraseña incorrecta'})
        
        if proc.returncode != 0 and not success:
            return jsonify({'success': False, 'error': output[:300]})
        
        # Cleanup files
        ovpn = f'{CLIENTS_DIR}/{name}.ovpn'
        if os.path.exists(ovpn):
            os.remove(ovpn)
        
        db = load_clients_db()
        if name in db.get('clients', {}):
            del db['clients'][name]
            save_clients_db(db)
        
        if os.path.exists(f'{CCD_DIR}/{name}'):
            os.remove(f'{CCD_DIR}/{name}')
        
        # Restart OpenVPN to reload CRL
        try:
            subprocess.run('docker restart openvpn', shell=True, timeout=30)
        except:
            pass
        
        return jsonify({'success': True, 'message': 'Cliente revocado. OpenVPN reiniciado.'})
        
    except subprocess.TimeoutExpired:
        return jsonify({'success': False, 'error': 'Timeout'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/download/<name>')
@login_required
def download(name):
    name = re.sub(r'[^a-zA-Z0-9_-]', '', name)
    path = f'{CLIENTS_DIR}/{name}.ovpn'
    if os.path.exists(path):
        return send_file(path, as_attachment=True, download_name=f'{name}.ovpn')
    return 'Archivo no encontrado', 404


# =============================================================================
# Main
# =============================================================================

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
