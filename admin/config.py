import os
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

VOLUME_NAME    = os.environ.get('VOLUME_NAME', 'openvpn_openvpn_data')
CLIENTS_DIR    = os.environ.get('CLIENTS_DIR', '/app/clients')
CCD_DIR        = os.environ.get('CCD_DIR', '/app/ccd')
CLIENTS_DB     = os.path.join(CLIENTS_DIR, 'clients.json')
ADMIN_PASSWORD = require_env('ADMIN_PASSWORD')
LOCAL_SERVER_IP = os.environ.get('LOCAL_SERVER_IP')

# =============================================================================
# Network — Subnet /16: 10.8.0.0 - 10.8.255.255
# =============================================================================
# Admin:   Group 0  → 10.8.0.1  - 10.8.0.254
# Group N: Group N  → 10.8.N.1  - 10.8.N.254   (N = 1-255)

VPN_SECOND_OCTET_START = 8
CLIENTS_PER_GROUP      = 254   # fourth octet 1-254
MAX_GROUPS             = 255   # group numbers 0-255
ADMIN_GROUP_NUM        = 0

# =============================================================================
# Concurrency
# =============================================================================

db_lock = threading.RLock()
