import os
import re
import threading


def require_env(name):
    """Require an environment variable to be set, fail fast otherwise."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value


# =============================================================================
# Paths & credentials
# =============================================================================

VOLUME_NAME = os.environ.get('VOLUME_NAME', 'openvpn_openvpn_data')
if not re.match(r'^[a-zA-Z0-9_-]+$', VOLUME_NAME):
    raise RuntimeError(f"VOLUME_NAME contains invalid characters: {VOLUME_NAME}")
CLIENTS_DIR    = os.environ.get('CLIENTS_DIR', '/app/clients')
CCD_DIR        = os.environ.get('CCD_DIR', '/app/ccd')
CCD_DIR_MODERN = os.environ.get('CCD_DIR_MODERN', '/app/ccd-modern')
CLIENTS_DB     = os.path.join(CLIENTS_DIR, 'clients.json')
ADMIN_PASSWORD = require_env('ADMIN_PASSWORD')
LOCAL_SERVER_IP = os.environ.get('LOCAL_SERVER_IP')

# =============================================================================
# Network — dos daemons, PKI compartida
# =============================================================================
# classic:  daemon1 (port 1194), subnet 10.8.0.0/16, UG67/UG65/UG56/Desktop
# modern:   daemon2 (port 1195), subnet 10.9.0.0/16, UG63v2 y futuros OpenVPN 2.5+
# Admin:    Group 0  → 10.8.0.1  - 10.8.0.254  (solo en classic)
# Group N:  Group N  → 10.{8|9}.N.1 - 10.{8|9}.N.254   (N = 1-255)

VPN_SECOND_OCTET_START = 8             # legacy — usar DAEMON_CONFIG['classic']['second_octet']
CLIENTS_PER_GROUP      = 254           # fourth octet 1-254
MAX_GROUPS             = 255           # group numbers 0-255
ADMIN_GROUP_NUM        = 0

DAEMON_CONFIG = {
    'classic': {
        'container':    'openvpn',
        'port':         1194,
        'second_octet': 8,
        'ccd_dir':      CCD_DIR,
    },
    'modern': {
        'container':    'openvpn-modern',
        'port':         1195,
        'second_octet': 9,
        'ccd_dir':      CCD_DIR_MODERN,
    },
}

# Clientes OpenVPN 2.5+ (UG63v2) rechazan comp-lzo → daemon2.
# Resto va a daemon1 (firmware 2.4 con comp-lzo).
MODEL_TO_DAEMON = {
    'UG67':    'classic',
    'UG65':    'classic',
    'UG56':    'classic',
    'Desktop': 'classic',
    'Other':   'classic',
    'UG63v2':  'modern',
}
DEFAULT_MODEL = 'UG67'

# =============================================================================
# Concurrency
# =============================================================================

db_lock = threading.RLock()
