import hmac
import logging
from functools import wraps

from flask import Blueprint, session, redirect, url_for, request, render_template, jsonify

from config import ADMIN_PASSWORD
from extensions import limiter

logger = logging.getLogger('openvpn_admin.auth')

bp = Blueprint('auth', __name__)


def login_required(f):
    """Decorator: redirect to login if not authenticated."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('auth.login'))
        return f(*args, **kwargs)
    return decorated


@bp.route('/health')
def health():
    return jsonify({'status': 'ok'}), 200


@bp.route('/login', methods=['GET', 'POST'])
@limiter.limit('5 per minute')
def login():
    if session.get('logged_in'):
        return redirect(url_for('auth.index'))
    error = None
    if request.method == 'POST':
        if hmac.compare_digest(request.form['password'], ADMIN_PASSWORD):
            session['logged_in'] = True
            session.permanent = True
            logger.info('login_success', extra={'ip': request.remote_addr})
            return redirect(url_for('auth.index'))
        error = 'Contraseña incorrecta'
        logger.warning('login_failed', extra={'ip': request.remote_addr})
    return render_template('login.html', error=error)


@bp.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('auth.login'))


@bp.route('/')
@login_required
def index():
    return render_template('index.html')
