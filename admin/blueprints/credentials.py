from flask import Blueprint, jsonify, request
import logging

from extensions import csrf
from db import load_clients_db, save_clients_db
from config import db_lock

logger = logging.getLogger('openvpn_admin.credentials')

credentials_bp = Blueprint('credentials', __name__)

@credentials_bp.route('', methods=['GET'])
def list_credentials():
    """Returns a list of all credentials mapped by client name."""
    db = load_clients_db()
    credentials = db.get('credentials', {})
    
    creds_list = []
    for client_name, cred in credentials.items():
        creds_list.append({
            'client_name': client_name,
            'url': cred.get('url', ''),
            'username': cred.get('username', ''),
            'password': cred.get('password', ''),
            'notes': cred.get('notes', '')
        })
        
    return jsonify({'success': True, 'credentials': creds_list})


@credentials_bp.route('/<client_name>', methods=['POST', 'PUT'])
def save_credential(client_name):
    """Saves or updates a credential for a specific client."""
    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'error': 'No data provided'}), 400
        
    url = data.get('url', '')
    username = data.get('username', '')
    password = data.get('password', '')
    notes = data.get('notes', '')
    
    if not client_name:
        return jsonify({'success': False, 'error': 'Client name is required'}), 400
        
    with db_lock:
        db = load_clients_db()
        
        if client_name not in db.get('clients', {}):
            return jsonify({'success': False, 'error': f'Cliente {client_name} no existe'}), 404
            
        if 'credentials' not in db:
            db['credentials'] = {}
            
        db['credentials'][client_name] = {
            'url': url,
            'username': username,
            'password': password,
            'notes': notes
        }
        
        save_clients_db(db)
        
    logger.info('credentials_saved', extra={'client': client_name})
    return jsonify({'success': True})


@credentials_bp.route('/<client_name>', methods=['DELETE'])
def delete_credential(client_name):
    """Deletes a credential for a specific client."""
    with db_lock:
        db = load_clients_db()
        
        if 'credentials' in db and client_name in db['credentials']:
            del db['credentials'][client_name]
            save_clients_db(db)
            
    logger.info('credentials_deleted', extra={'client': client_name})
    return jsonify({'success': True})
