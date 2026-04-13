# Code Review — openvpn_wedo

**Date:** 2025-03-25
**Scope:** Full repository (backend, frontend, infrastructure, documentation, cloud readiness)

---

## Executive Summary

| Severity | Count |
|----------|-------|
| Critical | 5 |
| High | 6 |
| Medium | 12 |
| Low | 6 |
| Documentation | 5 |
| Cloud Deployment | 10 |
| **Total** | **44** |

---

## 1. Critical Issues

### 1.1 Command Injection via `shell=True`

**Files:** `admin/app.py:673`, `691`, `755`, `797`

All subprocess calls that execute Docker commands use `shell=True` with f-string interpolation:

```python
# app.py:673
cmd = f'docker run -v {VOLUME_NAME}:/etc/openvpn --rm kylemanna/openvpn easyrsa build-client-full {name} nopass'
result_cert = subprocess.run(cmd, shell=True, capture_output=True, timeout=120)
```

While `name` is validated with `re.match(r'^[a-zA-Z0-9_-]+$', name)` before use, `VOLUME_NAME` comes from an environment variable with no validation. Using `shell=True` is inherently dangerous — any bypass of the regex or a malicious `VOLUME_NAME` allows arbitrary command execution.

**Fix:** Use argument lists instead of shell strings:
```python
cmd = ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
       'kylemanna/openvpn', 'easyrsa', 'build-client-full', name, 'nopass']
subprocess.run(cmd, capture_output=True, timeout=120)
```

---

### 1.2 XSS via `innerHTML` with Unsanitized Data

**File:** `admin/static/js/app.js`

Multiple locations inject server-returned data directly into the DOM via `innerHTML` without sanitization:

| Line(s) | Data injected | Context |
|---------|---------------|---------|
| 412–413 | `c.name`, `c.ip` | Client cards |
| 457 | `c.group_icon`, `c.group_name` | Connected clients table |
| 461 | `c.vpn_ip` (used in `href`) | Clickable link — potential `javascript:` injection |
| 465–470 | `c.name`, `c.real_ip`, `c.connected_since` | Connected clients table |
| 500–503 | `c.name`, `c.real_ip`, `c.reason` | Rejected clients table |

If any of these values contain HTML or JavaScript, it executes in the user's browser.

**Fix:** Use `textContent` for text nodes, or sanitize with a function like:
```javascript
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
```

---

### 1.3 Race Condition on JSON Database

**File:** `admin/app.py:136–172`

`load_clients_db()` and `save_clients_db()` have no locking mechanism. Flask serves requests concurrently, so:

1. Request A reads `clients.json`
2. Request B reads the same stale file
3. Request A writes updated data
4. Request B overwrites with its stale copy — **Request A's changes are lost**

This directly affects IP assignment: two simultaneous `create_client` calls could assign the same IP to different clients, breaking the VPN network.

**Fix:** Add a threading lock around all DB access:
```python
import threading
db_lock = threading.Lock()

def load_clients_db():
    with db_lock:
        ...

def save_clients_db(db):
    with db_lock:
        ...
```

Or migrate to SQLite, which has built-in concurrency control.

---

### 1.4 Docker Socket Exposed to Admin Container

**File:** `docker-compose.yml:59`

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

The admin container has unrestricted access to the Docker daemon. If an attacker gains code execution in the container (e.g., via the command injection in 1.1), they can control the entire host through Docker — creating containers, reading volumes, escalating to root.

**Fix:** Use a Docker socket proxy like [Tecnativa/docker-socket-proxy](https://github.com/Tecnativa/docker-socket-proxy) to restrict which API endpoints the container can access. At minimum, limit to `containers` and `volumes`.

---

### 1.5 No Backup or Recovery Mechanism

**Scope:** Project-wide

Three critical data stores have zero backup strategy:

| Data | Location | Impact if lost |
|------|----------|----------------|
| PKI (certificates, keys, CA) | `openvpn_openvpn_data` Docker volume | All clients permanently disconnected; must regenerate everything |
| Client database | `clients/clients.json` | Loss of all group/client metadata and IP assignments |
| Client configs (CCD) | `ccd/` directory | Clients lose fixed IPs; group isolation breaks |

There is no automated backup, no snapshot mechanism, and no documented restore procedure.

**Fix:** Implement a scheduled backup script (e.g., cron) that:
- Exports the Docker volume: `docker run --rm -v openvpn_openvpn_data:/data -v /backups:/backup alpine tar czf /backup/pki-$(date +%Y%m%d).tar.gz -C /data .`
- Copies `clients.json` with a timestamp
- Backs up the `ccd/` directory

---

## 2. High Severity Issues

### 2.1 No CSRF Protection

**Files:** `admin/app.py` (all POST/PUT routes), `admin/static/js/app.js` (all `fetch()` calls)

No CSRF tokens are generated, embedded in forms, or validated on the server. An attacker can craft a page that submits requests to the admin panel on behalf of an authenticated user — creating clients, revoking certificates, or modifying groups.

**Fix:** Install `Flask-WTF` and enable `CSRFProtect(app)`. Add `X-CSRFToken` header to all fetch requests in `app.js`.

---

### 2.2 No Session Timeout

**File:** `admin/app.py:298`

```python
session['logged_in'] = True  # No expiration
```

Once a user logs in, the session persists indefinitely until the browser is closed (and even then, depends on browser settings). An unattended terminal remains fully authenticated.

**Fix:**
```python
app.config['PERMANENT_SESSION_LIFETIME'] = timedelta(hours=8)

@app.route('/login', methods=['POST'])
def login():
    ...
    session.permanent = True
```

---

### 2.3 No Brute Force Protection on Login

**File:** `admin/app.py:297`

```python
if request.form['password'] == ADMIN_PASSWORD:
```

No rate limiting, no account lockout, no delay after failed attempts, no logging of failed attempts. An attacker can try unlimited passwords per second.

**Fix:** Use `Flask-Limiter` to restrict login attempts (e.g., 5 per minute per IP). Log all failed attempts.

---

### 2.4 Hardcoded Default Credentials

**File:** `docker-compose.yml:55–56`

```yaml
- ADMIN_PASSWORD=${ADMIN_PASSWORD:-admin123}
- SECRET_KEY=${SECRET_KEY:-simple_secret}
```

If the `.env` file is missing or incomplete, the application runs with known default credentials. The `SECRET_KEY` default (`simple_secret`) allows session forgery.

**Fix:** Remove defaults. Fail at startup if these variables are not set:
```python
ADMIN_PASSWORD = os.environ.get('ADMIN_PASSWORD')
if not ADMIN_PASSWORD:
    raise RuntimeError("ADMIN_PASSWORD environment variable is required")
```

---

### 2.5 TOCTTOU in IP Assignment

**File:** `admin/app.py:651` → `717`

```python
assigned_ip = get_next_ip_for_group(group_id)  # line 651: CHECK
# ... 60+ lines of CCD creation, certificate generation, config export ...
confirm_ip_used(group_id, client_num)           # line 717: USE
```

Between the check and the confirmation, another concurrent request can grab the same IP. This is a Time-of-Check-Time-of-Use (TOCTTOU) bug directly related to the race condition in 1.3.

**Fix:** Resolved by the file locking in 1.3. Check and confirm should happen atomically within the same locked block.

---

### 2.6 Credentials Stored in Documentation

**File:** `INFRAESTRUCTURA.md:252`

The infrastructure documentation contains plaintext credentials (SSH password, panel password). This file is committed to the repository.

**Fix:** Remove all credentials from tracked files. Reference `.env` (which is git-ignored) as the sole location for secrets.

---

## 3. Medium Severity Issues

### 3.1 Bare `except:` Clauses

**File:** `admin/app.py:93`, `128`, `241`, `503`, `617`

Multiple bare `except:` blocks catch and silently discard all exceptions, including programming errors (`NameError`, `AttributeError`):

```python
# app.py:241
try:
    ip_octet = int(ip_str.split('.')[-1])
except:
    pass  # Hides any error
```

**Fix:** Catch specific exceptions (`ValueError`, `IndexError`, `KeyError`). Log unexpected errors.

---

### 3.2 Error Messages Leak System Information

**File:** `admin/app.py:688`, `780`, `806`

```python
return jsonify({'success': False, 'error': stderr.decode()[:200]})
return jsonify({'success': False, 'error': str(e)})
```

Docker error output and Python exception details are returned to the frontend, potentially revealing internal paths, container names, and infrastructure details.

**Fix:** Log detailed errors server-side. Return generic messages to the client (e.g., `"Client creation failed"`).

---

### 3.3 No Logging Framework

**File:** `admin/app.py:559`, `618`

The application uses `print()` for error output:

```python
print(f"Error getting connected clients: {e}")
```

There is no audit trail of who created or revoked clients, no record of failed login attempts, and no structured error logging.

**Fix:** Replace with Python's `logging` module. Configure log levels and format. Log all authentication and client management operations.

---

### 3.4 No Rate Limiting on Any Endpoint

All API endpoints (`/api/create`, `/api/revoke`, `/api/groups`, etc.) accept unlimited requests. This enables resource exhaustion by rapidly creating clients or groups.

**Fix:** Add `Flask-Limiter` with reasonable defaults (e.g., 30 requests/minute for creation endpoints).

---

### 3.5 No Health Checks in Docker Compose

**File:** `docker-compose.yml`

Neither the `openvpn` nor `openvpn-admin` service defines a health check. Containers could be in a broken state without detection. `restart: always` will restart crashed containers but not zombied ones.

**Fix:** Add health checks:
```yaml
openvpn-admin:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8080/login"]
    interval: 30s
    timeout: 10s
    retries: 3
```

---

### 3.6 Dockerfile Runs as Root

**File:** `admin/Dockerfile`

No `USER` directive — the Flask application runs as root inside the container. Combined with the Docker socket mount (1.4), this maximizes the impact of any container escape.

**Fix:**
```dockerfile
RUN useradd -m -u 1000 appuser
USER appuser
```

Note: The Docker socket must be readable by this user (add to `docker` group or adjust socket permissions).

---

### 3.7 Docker Binary Downloaded Without Verification

**File:** `admin/Dockerfile:13–15`

```dockerfile
curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz | tar zxvf - ...
```

The Docker CLI binary is downloaded and extracted without verifying a checksum or GPG signature. A MITM attack during build could inject a malicious binary.

**Fix:** Add checksum verification:
```dockerfile
RUN curl -fsSL -o docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    && echo "<sha256hash> docker.tgz" | sha256sum -c - \
    && tar zxvf docker.tgz --strip-components 1 -C /usr/bin docker/docker \
    && rm docker.tgz
```

---

### 3.8 Flask Dependency Not Version-Pinned

**File:** `admin/Dockerfile:3`

```dockerfile
RUN pip install flask
```

No version pinning. A new Flask release could break the application or introduce vulnerabilities. No `requirements.txt` exists.

**Fix:** Create `admin/requirements.txt` with pinned versions:
```
flask==3.1.0
```

---

### 3.9 Hardcoded Internal IP Default

**File:** `admin/app.py:27`

```python
LOCAL_SERVER_IP = os.environ.get('LOCAL_SERVER_IP', '172.28.20.206')
```

The default is specific to one deployment. If the env var is not set, all generated `.ovpn` configs will contain the wrong IP.

**Fix:** Remove the default. Require the env var, or omit the dual-remote feature when not configured.

---

### 3.10 Runtime Secret Key Generation

**File:** `admin/app.py:20`

```python
app.secret_key = os.environ.get('SECRET_KEY', secrets.token_hex(32))
```

If `SECRET_KEY` is not set (and the default from docker-compose is overridden), a random key is generated at startup. Container restarts invalidate all sessions. Multiple instances would have different keys.

**Fix:** Require `SECRET_KEY` to be set explicitly (see 2.4).

---

### 3.11 Double-Counting in Rejected Clients Logic

**File:** `admin/app.py:600–615`

The rejected clients endpoint counts attempts in two separate loops, then divides by 2 to "correct" the double count:

```python
rejected[name]['attempts'] = max(1, rejected[name]['attempts'] // 2)
```

This is fragile — if the log format changes, the division factor becomes wrong.

**Fix:** Parse the log once with a single pass, counting each relevant line exactly once.

---

### 3.12 Brittle OpenVPN Status File Parsing

**File:** `admin/app.py:518`

The connected clients endpoint parses the OpenVPN status file by looking for hardcoded markers like `Common Name,` and `ROUTING TABLE`. If the OpenVPN version changes its output format, the parsing breaks silently.

**Fix:** Use OpenVPN's management interface or add format version detection with graceful fallback.

---

## 4. Low Severity Issues

### 4.1 Duplicate Cleanup Code

**File:** `admin/app.py:680`, `696`, `731`, `765`, `785`

Identical file cleanup logic (remove CCD file, remove .ovpn, delete from DB) is repeated 5 times across `create_client` and `revoke_client`.

**Fix:** Extract to a `cleanup_client_files(name)` helper.

---

### 4.2 Unnecessary Local Import Alias

**File:** `admin/app.py:705`

```python
import re as re_mod
ovpn_content = re_mod.sub(...)
```

`re` is already imported globally at the top of the file. This local aliased import is confusing.

**Fix:** Use `re.sub(...)` directly.

---

### 4.3 Unused Variables

**File:** `admin/app.py:675`

```python
stdout, stderr = result_cert.stdout, result_cert.stderr
```

`stdout` is assigned but never used.

**Fix:** Remove the unused assignment: `stderr = result_cert.stderr`.

---

### 4.4 Overly Long Functions

**File:** `admin/app.py`

| Function | Lines | Responsibilities |
|----------|-------|-----------------|
| `create_client()` | 623–738 (115 lines) | Validation, cert generation, config export, CCD creation, DB update |
| `revoke_client()` | 741–806 (65 lines) | Validation, revocation, cleanup, DB update, restart |
| `connected_clients()` | 487–561 (74 lines) | Status parsing, log parsing, data enrichment |

Each function handles too many concerns, making them hard to test and maintain.

**Fix:** Extract into smaller helpers: `generate_certificate()`, `export_ovpn_config()`, `cleanup_client()`, `parse_openvpn_status()`.

---

### 4.5 Magic Numbers Without Named Constants

**File:** `admin/app.py`

- Line 497, 572: `--tail 200` / `--tail 500` without explanation
- Line 123: `-3 hours` offset for Argentina timezone — should be a named constant
- Timeout values (120, 30) scattered through subprocess calls

**Fix:** Define constants at the top of the file:
```python
TIMEZONE_OFFSET_HOURS = -3
LOG_TAIL_LINES = 500
CERT_GENERATION_TIMEOUT = 120
```

---

### 4.6 Shell Scripts Missing Input Validation

**Files:** `setup.sh`, `create-client.sh`, `revoke-client.sh`

- `setup.sh` does not validate that `$1` is a valid IP address format
- `create-client.sh` does not validate client name characters
- `revoke-client.sh` does not validate client name characters

**Fix:** Add regex validation in each script:
```bash
if ! [[ $1 =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  echo "Invalid IP address format"; exit 1
fi
```

---

## 5. Documentation Errors

### 5.1 Wrong Repository URL in README

**File:** `README.md:34`

```
git clone https://github.com/GuilleFerru/openvpn_vdd.git
```

The repo name is `openvpn_wedo`, not `openvpn_vdd`.

---

### 5.2 Incorrect Capacity Numbers in User Guide

**File:** `GUIA_USUARIO.md:88`

Claims the system supports **340 groups** and **4,080 clients**. The actual limits (from code constants and `/16` subnet):
- Groups: **255** (1–255, plus admin at 0)
- Clients per group: **254** (1–254)
- Total capacity: **255 × 254 = 64,770 clients**

---

### 5.3 Wrong IPs-per-Group Count

**File:** `GUIA_USUARIO.md:74`

States each group gets **12 IPs**. The actual allocation is **254 IPs** per group (a full `/24` minus network and broadcast).

---

### 5.4 Orphaned CCD Files

**Files:** `ccd/GW001`, `ccd/GW001-Valija`, `ccd/WeDo_Admin`

Three CCD files exist on disk, but `clients/clients.json` has an empty `"clients": {}` object. The data is out of sync — these clients exist in OpenVPN but not in the admin panel's database.

**Fix:** Either run the `/api/recalculate` endpoint to rebuild counters, or manually clean up the orphaned files.

---

### 5.5 Placeholder Images in User Guide

**File:** `GUIA_USUARIO.md:26`

Uses `https://via.placeholder.com/...` URLs instead of actual screenshots.

---

## 6. Cloud Deployment — Google Cloud (GCE)

### Recommended Architecture

The system requires UDP port 1194, kernel `tun/tap` modules, and a persistent Docker daemon — this rules out Cloud Run and makes GKE unnecessarily complex. **A single GCE VM running Docker Compose is the right fit.**

```
                   Internet
                      │
              ┌───────┴───────┐
              │  GCE Static IP │
              └───────┬───────┘
                      │
         ┌────────────┼────────────┐
         │ UDP 1194   │ TCP 443    │
         ▼            ▼            │
    ┌─────────┐  ┌─────────┐      │
    │ OpenVPN │  │  Caddy   │◄─────┘
    │ Server  │  │ (reverse │
    │         │  │  proxy)  │
    └─────────┘  └────┬────┘
                      │ :8080
                 ┌────▼────┐
                 │  Flask   │
                 │  Admin   │
                 └─────────┘
```

- **Caddy** handles HTTPS termination with auto Let's Encrypt certificates
- **Flask** stays on internal port 8080, never exposed directly
- **OpenVPN** keeps UDP 1194 exposed
- The Docker socket pattern works on GCE since it's a regular VM
- Infrastructure (Terraform for VM, firewall rules, DNS, static IP) lives in the separate repo

---

### 6.1 Add HTTPS via Reverse Proxy

**Current:** Flask serves HTTP on port 8888, directly exposed. Credentials transmitted in plaintext.

**Problem:** Internet-facing admin panel without TLS is unacceptable. Passwords, session cookies, and `.ovpn` files (containing private keys) travel unencrypted.

**Fix:** Add a Caddy service to `docker-compose.yml`:

```yaml
caddy:
  image: caddy:2-alpine
  restart: always
  ports:
    - "443:443"
    - "80:80"
  volumes:
    - ./Caddyfile:/etc/caddy/Caddyfile
    - caddy_data:/data
  depends_on:
    - openvpn-admin
```

Create `Caddyfile`:
```
{$DOMAIN:localhost} {
  reverse_proxy openvpn-admin:8080
}
```

With a domain name pointed at the GCE static IP, Caddy automatically provisions and renews Let's Encrypt TLS certificates. No manual cert management needed.

Remove the current direct port exposure in docker-compose:
```yaml
# REMOVE this:
ports:
  - "8888:8080"
# Flask is only reachable through Caddy now
```

---

### 6.2 Add a Production WSGI Server

**File:** `admin/app.py:824`, `admin/Dockerfile:19`

**Current:**
```python
app.run(host='0.0.0.0', port=8080)
```

Flask's built-in server is single-threaded and not designed for production. It will log a warning: `WARNING: This is a development server. Do not use it in a production deployment.`

**Fix:** Use Gunicorn as the production server.

Add to `admin/requirements.txt`:
```
gunicorn==23.0.0
```

Update `admin/Dockerfile` CMD:
```dockerfile
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "300", "app:app"]
```

The high `--timeout` is needed because certificate generation (`easyrsa build-client-full`) can take over 60 seconds.

---

### 6.3 Add Health Check Endpoint

**File:** `admin/app.py`

GCE managed instance groups and load balancers require a health check endpoint. Even with Caddy in front, the docker-compose health check needs it.

**Fix:** Add to `app.py`:
```python
@app.route('/health')
def health():
    return jsonify({'status': 'ok'}), 200
```

No authentication — health checks must be unauthenticated. Update `docker-compose.yml`:
```yaml
openvpn-admin:
  healthcheck:
    test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
    interval: 30s
    timeout: 10s
    retries: 3
```

---

### 6.4 Structured Logging for Cloud Logging

**File:** `admin/app.py`

**Current:** `print()` statements. Google Cloud Logging can capture stdout/stderr, but unstructured text is hard to filter, alert on, or correlate.

**Fix:** Use Python `logging` with JSON format so Cloud Logging automatically parses severity, message, and metadata:

Add to `admin/requirements.txt`:
```
python-json-logger==2.0.7
```

Replace all `print()` calls in `app.py` with a configured logger:
```python
import logging
from pythonjsonlogger import jsonlogger

logger = logging.getLogger('openvpn-admin')
handler = logging.StreamHandler()
handler.setFormatter(jsonlogger.JsonFormatter(
    '%(asctime)s %(levelname)s %(message)s'
))
logger.addHandler(handler)
logger.setLevel(logging.INFO)
```

Log all sensitive operations:
```python
logger.info("Client created", extra={"client": name, "group": group_id, "ip": assigned_ip})
logger.warning("Failed login attempt", extra={"remote_ip": request.remote_addr})
logger.info("Client revoked", extra={"client": name})
```

---

### 6.5 Secure Session Cookies for HTTPS

**File:** `admin/app.py`

**Current:** No cookie security flags. When behind HTTPS, cookies must be marked `Secure` to prevent interception over downgraded connections.

**Fix:** Add after `app.secret_key`:
```python
app.config.update(
    SESSION_COOKIE_SECURE=True,       # Only send over HTTPS
    SESSION_COOKIE_HTTPONLY=True,      # No JavaScript access
    SESSION_COOKIE_SAMESITE='Lax',    # CSRF mitigation
    PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
)
```

---

### 6.6 Remove Hardcoded Local IP / Adapt Dual-Remote Logic

**File:** `admin/app.py:27`, `703–711`

**Current:**
```python
LOCAL_SERVER_IP = os.environ.get('LOCAL_SERVER_IP', '172.28.20.206')
```

The dual-remote feature injects a LAN IP as the primary `remote` in `.ovpn` files with the public IP as fallback. On GCE, there is no "local network" for clients — they connect over the internet exclusively.

**Fix:** Make the dual-remote feature conditional. If `LOCAL_SERVER_IP` is not set, skip the injection entirely:

```python
LOCAL_SERVER_IP = os.environ.get('LOCAL_SERVER_IP')  # No default

# In create_client(), around line 703:
if LOCAL_SERVER_IP:
    ovpn_content = re.sub(
        r'remote (\S+) (\d+) (\S+)',
        f'remote {LOCAL_SERVER_IP} \\2 \\3\nremote \\1 \\2 \\3',
        ovpn_content, count=1
    )
```

For GCE, simply don't set `LOCAL_SERVER_IP` in the environment.

---

### 6.7 Make File Paths Configurable

**File:** `admin/app.py:22–25`

**Current:**
```python
VOLUME_NAME = "openvpn_openvpn_data"
CLIENTS_DIR = "/app/clients"
CCD_DIR = "/app/ccd"
CLIENTS_DB = "/app/clients/clients.json"
```

All paths are hardcoded. If the deployment method changes (different volume mount points, GCS FUSE, etc.), the code must be edited.

**Fix:**
```python
VOLUME_NAME = os.environ.get('VOLUME_NAME', 'openvpn_openvpn_data')
CLIENTS_DIR = os.environ.get('CLIENTS_DIR', '/app/clients')
CCD_DIR = os.environ.get('CCD_DIR', '/app/ccd')
CLIENTS_DB = os.path.join(CLIENTS_DIR, 'clients.json')
```

---

### 6.8 Fail Fast on Missing Required Configuration

**File:** `admin/app.py:20`, `26`

On a GCE deployment, secrets will come from Google Secret Manager (injected as env vars by the infrastructure layer). The app must refuse to start if critical configuration is missing — silent fallbacks to `admin123` are dangerous.

**Fix:**
```python
def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Required environment variable {name} is not set")
    return value

ADMIN_PASSWORD = require_env('ADMIN_PASSWORD')
app.secret_key = require_env('SECRET_KEY')
```

---

### 6.9 Add `.dockerignore`

**File:** `admin/.dockerignore` (new file)

Without a `.dockerignore`, the Docker build context includes everything — `.git`, `.env`, documentation, shell scripts. This bloats the image and risks leaking secrets into the container layer.

**Fix:** Create `admin/.dockerignore`:
```
__pycache__
*.pyc
.env
.git
*.md
```

---

### 6.10 Harden Dockerfile for Production

**File:** `admin/Dockerfile`

Current Dockerfile has several issues for a production internet-facing deployment (also referenced in 3.6, 3.7, 3.8). Combined production-ready version:

```dockerfile
FROM python:3.11-slim

WORKDIR /app

# Pin dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Docker CLI with checksum verification
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -fsSL -o /tmp/docker.tgz \
       https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    && tar xzf /tmp/docker.tgz --strip-components 1 -C /usr/bin docker/docker \
    && rm /tmp/docker.tgz \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -g 999 docker && useradd -m -u 1000 -G docker appuser

COPY --chown=appuser:appuser app.py .
COPY --chown=appuser:appuser templates/ templates/
COPY --chown=appuser:appuser static/ static/

USER appuser
EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "300", "app:app"]
```

---

## 7. Recommended Fix Priority

The priority has been reordered considering the cloud deployment target.

### Phase 1 — Deploy blockers (must fix before going to GCE)

| # | Item | Ref |
|---|------|-----|
| 1 | Remove `shell=True` — use argument lists for subprocess | 1.1 |
| 2 | Add file locking for `clients.json` | 1.3 |
| 3 | Fail fast on missing env vars (no default credentials) | 6.8, 2.4 |
| 4 | Add HTTPS reverse proxy (Caddy) to docker-compose | 6.1 |
| 5 | Switch to Gunicorn production server | 6.2 |
| 6 | Harden Dockerfile (non-root, pinned deps, .dockerignore) | 6.10, 6.9 |
| 7 | Add `/health` endpoint | 6.3 |
| 8 | Secure session cookies (Secure, HttpOnly, SameSite) | 6.5 |

### Phase 2 — Security hardening (before exposing to internet)

| # | Item | Ref |
|---|------|-----|
| 9 | Add CSRF protection with Flask-WTF | 2.1 |
| 10 | Sanitize all `innerHTML` in frontend | 1.2 |
| 11 | Add session timeout | 2.2 |
| 12 | Add login rate limiting (Flask-Limiter) | 2.3 |
| 13 | Stop leaking error details to frontend | 3.2 |
| 14 | Remove credentials from documentation | 2.6 |
| 15 | Replace bare `except:` with specific exceptions | 3.1 |

### Phase 3 — Production readiness ✅ Complete

| # | Item | Ref | Status |
|---|------|-----|--------|
| 16 | Structured JSON logging for Cloud Logging | 6.4 | ✅ `python-json-logger`, all `print()` replaced |
| 17 | Make dual-remote conditional (remove hardcoded IP) | 6.6 | ✅ Done in Phase 1 (`LOCAL_SERVER_IP` optional) |
| 18 | Make file paths configurable via env vars | 6.7 | ✅ Done in Phase 1 (`CLIENTS_DIR`, `CCD_DIR`, `VOLUME_NAME`) |
| 19 | Implement backup strategy for volumes and data | 1.5 | ✅ `backup.sh` — exports PKI volume, clients.json, ccd/ |
| 20 | Add health checks to docker-compose services | 3.5 | ✅ Done in Phase 1 (`/health` endpoint + docker-compose healthcheck) |

### Phase 4 — Tech debt ✅ Complete

| # | Item | Ref | Status |
|---|------|-----|--------|
| 21 | Extract duplicate cleanup code | 4.1 | ✅ `_remove_ccd()`, `_cleanup_client_files()` helpers |
| 22 | Break up long functions | 4.4 | ✅ `_write_ccd()`, `_run_easyrsa_build()`, `_export_ovpn_config()` extracted |
| 23 | Fix documentation errors | 5.1–5.5 | ✅ README repo URL, port; GUIA_USUARIO capacity, CA password, IP tip |
| 24 | Docker socket proxy for least-privilege access | 1.4 | ✅ `tecnativa/docker-socket-proxy` — only CONTAINERS/IMAGES/POST/DELETE allowed |
