# Auditoría de Seguridad — OpenVPN WeDo Admin Panel

**Fecha:** 2026-04-14
**Auditor:** Claude Code (asistido por GuilleFerru)
**Alcance:** Backend Flask, frontend JS, Docker, infraestructura de red

---

## Resumen ejecutivo

| Categoría | Estado | Detalle |
|-----------|--------|---------|
| Autenticación | **DEBIL** | Password en texto plano, sin hashing, vulnerable a timing attack |
| Sesiones | **BUENO** | Cookie flags correctos (Secure, HttpOnly, SameSite) |
| CORS | **BUENO** | No configurado = seguro por defecto (single-origin) |
| Protección de API | **BUENO** | Todas las rutas requieren `@login_required` |
| Validación de input | **BUENO** | Regex allowlist estricto en nombres de clientes/grupos |
| CSRF | **BUENO** | Flask-WTF configurado, tokens en headers AJAX |
| Headers de seguridad | **CRITICO** | Faltan CSP, X-Frame-Options, HSTS, nosniff |
| Manejo de secretos | **DEBIL** | ADMIN_PASSWORD en texto plano en env vars |
| Docker / Shell injection | **SEGURO** | subprocess con listas, sin `shell=True` ni `os.system()` |
| Operaciones de archivos | **SEGURO** | Sanitización previene path traversal |
| Rate limiting | **PARCIAL** | Login protegido, endpoints API sin límite |
| XSS (cliente) | **BUENO** | Escape DOM, `esc()` helper, sin innerHTML directo con user input |
| Script externo | **RIESGO** | Lucide CDN sin versión fija (`@latest`) |

---

## 1. Autenticación y contraseña

### Estado actual

- **`blueprints/auth.py:36`** — Comparación directa con `==`:
  ```python
  if request.form['password'] == ADMIN_PASSWORD:
  ```
- **`config.py:21`** — Password en texto plano desde env var:
  ```python
  ADMIN_PASSWORD = require_env('ADMIN_PASSWORD')
  ```
- Sin política de complejidad ni longitud mínima
- Sin hashing (bcrypt, argon2)
- Rate limit de login: 5 intentos/minuto (OK)

### Vulnerabilidades

1. **Timing attack**: `==` filtra longitud del password por diferencia de tiempo de respuesta
2. **Sin hashing**: si el `.env` se filtra, el password queda expuesto
3. **Sin rotación**: cambiar password requiere redeploy

### Recomendaciones

```python
# auth.py — comparación segura
import hmac

def check_password(provided, stored):
    return hmac.compare_digest(
        provided.encode('utf-8'),
        stored.encode('utf-8')
    )
```

Para hashing completo (si se escala a múltiples usuarios):
```python
# pip install argon2-cffi
from argon2 import PasswordHasher
ph = PasswordHasher()

# Al crear: hash = ph.hash(password)
# Al verificar: ph.verify(hash, password)
```

**Mínimo viable para este proyecto**: reemplazar `==` con `hmac.compare_digest()`.

---

## 2. CORS

### Estado actual

- No se usa Flask-CORS ni se setean headers `Access-Control-Allow-Origin`
- Flask por defecto **no** envía headers CORS

### Evaluación

**Seguro por defecto.** El panel es single-origin (`vpn.we-do.io`), no necesita CORS. Un browser no permitirá requests cross-origin a la API.

### Recomendación

No activar CORS salvo necesidad futura. Si se necesita, usar allowlist explícito:
```python
# NUNCA usar Access-Control-Allow-Origin: *
# Solo si fuera necesario:
CORS(app, origins=['https://vpn.we-do.io'])
```

---

## 3. Seguridad de la API

### Protección de rutas

Todas las rutas `/api/*` están protegidas con `@login_required`:

| Ruta | Método | Auth | Rate limit | CSRF |
|------|--------|------|------------|------|
| `/api/groups` | GET | Si | No | N/A (GET) |
| `/api/groups` | POST | Si | **No** | Si |
| `/api/groups/<id>` | PUT | Si | **No** | Si |
| `/api/next-group-range` | GET | Si | No | N/A |
| `/api/recalculate` | POST | Si | **No** | Si |
| `/api/clients` | GET | Si | No | N/A |
| `/api/connected` | GET | Si | No | N/A |
| `/api/rejected` | GET | Si | No | N/A |
| `/api/create` | POST | Si | **No** | Si |
| `/api/revoke` | POST | Si | **No** | Si |
| `/download/<name>` | GET | Si | No | N/A |
| `/health` | GET | **No** | No | N/A |

### Vulnerabilidades

- **`/api/create` sin rate limit**: un atacante autenticado podría generar cientos de certificados
- **`/api/revoke` sin rate limit**: podría reiniciar OpenVPN repetidamente (DoS)
- **`/api/recalculate` sin rate limit**: carga innecesaria

### Recomendación

```python
# blueprints/clients.py
@bp.route('/api/create', methods=['POST'])
@login_required
@limiter.limit('10 per minute')
def create_client():
    ...

@bp.route('/api/revoke', methods=['POST'])
@login_required
@limiter.limit('5 per minute')
def revoke_client():
    ...
```

---

## 4. CSRF

### Estado actual

- **`extensions.py`**: `CSRFProtect()` inicializado
- **`app.py:33-43`**: Token expuesto via cookie (`httponly=False`, necesario para JS)
- **`app.js:24-35`**: JS lee cookie y envía `X-CSRFToken` en cada request mutante
- `WTF_CSRF_TIME_LIMIT=None` — token válido durante toda la sesión

### Evaluación

**Bien implementado.** El patrón Double-Submit Cookie funciona correctamente:
1. Server genera token → cookie
2. JS lee cookie → header `X-CSRFToken`
3. Flask-WTF valida header vs session

### Nota

`WTF_CSRF_SSL_STRICT=False` es necesario por Traefik como reverse proxy (el referer puede no coincidir). Aceptable en este contexto.

---

## 5. Headers de seguridad

### Estado actual

**No se setean headers de seguridad HTTP.** Solo los cookie flags.

### Faltantes críticos

| Header | Propósito | Impacto sin él |
|--------|-----------|----------------|
| `X-Frame-Options: DENY` | Anti-clickjacking | Panel puede ser embebido en iframe malicioso |
| `X-Content-Type-Options: nosniff` | Previene MIME sniffing | Browser podría interpretar archivos .ovpn como HTML |
| `Content-Security-Policy` | Controla orígenes de scripts/estilos | XSS más fácil de explotar |
| `Strict-Transport-Security` | Fuerza HTTPS | Primer request podría ir por HTTP |
| `Referrer-Policy: no-referrer` | No filtra URLs internas | Referer podría exponer rutas internas |

### Recomendación — agregar en `app.py`

```python
@app.after_request
def set_security_headers(response):
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; "
        "script-src 'self' https://unpkg.com; "
        "style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data:; "
        "connect-src 'self'"
    )
    return response
```

---

## 6. Manejo de secretos

### Estado actual

| Secreto | Origen | Almacenamiento |
|---------|--------|----------------|
| `SECRET_KEY` | `require_env()` | `.env` en VM |
| `ADMIN_PASSWORD` | `require_env()` | `.env` en VM |
| `LOCAL_SERVER_IP` | `os.environ.get()` | `.env` en VM |

- `.env` no está en el repo (`.gitignore` lo excluye)
- Acceso a VM solo por IAP SSH (sin SSH público)

### Riesgos

- Env vars visibles via `/proc/<pid>/environ` en Linux
- `docker inspect` del container muestra env vars
- Sin rotación automática

### Recomendaciones

1. **Mínimo**: validar entropía mínima de `SECRET_KEY` (>32 chars)
2. **Ideal**: usar GCP Secret Manager en vez de `.env`
3. **Para este proyecto**: el riesgo es aceptable dado que solo admins acceden a la VM via IAP

---

## 7. Docker socket y subprocess

### Estado actual

La app ejecuta comandos Docker via `subprocess.run()` con listas (no strings):

```python
# vpn.py:46-59 — ejemplo
subprocess.run(
    ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
     'kylemanna/openvpn', 'easyrsa', 'build-client-full', name, 'nopass'],
    capture_output=True, timeout=120,
)
```

### Evaluación

- **Sin shell injection**: todas las llamadas usan formato lista
- **Sin `shell=True`**: no hay inyección posible
- **Sin `os.system()`**: no encontrado en ningún archivo
- **Input validado**: `name` pasa por regex `^[a-zA-Z0-9_-]+$` antes de llegar al subprocess

### Riesgo menor

`VOLUME_NAME` viene de env var sin validación. Si un atacante controlara esa variable, podría montar volúmenes arbitrarios. Mitigación: validar formato.

```python
# config.py
VOLUME_NAME = os.environ.get('VOLUME_NAME', 'openvpn_openvpn_data')
if not re.match(r'^[a-zA-Z0-9_-]+$', VOLUME_NAME):
    raise RuntimeError('VOLUME_NAME contains invalid characters')
```

---

## 8. Operaciones de archivos

### Download de .ovpn

```python
# blueprints/clients.py:276
name = re.sub(r'[^a-zA-Z0-9_-]', '', name)
path = os.path.join(CLIENTS_DIR, f'{name}.ovpn')
```

**Seguro.** Regex strip elimina `../`, `\`, y cualquier carácter de path traversal.

### Escritura de CCD

```python
# vpn.py:36-43
ccd_path = os.path.join(CCD_DIR, name)
```

**Seguro.** `name` ya validado por regex antes de llegar aquí.

### Mejora opcional

Agregar `os.path.basename()` como doble protección:
```python
ccd_path = os.path.join(CCD_DIR, os.path.basename(name))
```

---

## 9. Sesiones y cookies

### Estado actual (`app.py:22-25`)

```python
SESSION_COOKIE_SECURE = True      # Solo HTTPS
SESSION_COOKIE_HTTPONLY = True     # No accesible desde JS
SESSION_COOKIE_SAMESITE = 'Lax'   # Protección contra CSRF básica
PERMANENT_SESSION_LIFETIME = timedelta(hours=8)
```

### Evaluación

**Excelente configuración.** Los 4 flags están correctamente seteados.

---

## 10. XSS y seguridad del frontend

### Protecciones existentes

- **`app.js:14-18`**: función `esc()` para escape HTML via DOM
- **`app.js:285-299`**: construcción DOM en vez de innerHTML para mensajes dinámicos
- **`app.js:524-527`**: validación regex de IPs antes de usar en `href`
- **`app.js:293, 479`**: `encodeURIComponent()` en URLs

### Riesgo: script externo sin versión

```html
<!-- index.html:9 -->
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
```

`@latest` significa que si unpkg o el paquete Lucide son comprometidos, el panel carga código malicioso automáticamente.

### Recomendación

Fijar versión + agregar `integrity` hash:
```html
<script
  src="https://unpkg.com/lucide@0.474.0/dist/umd/lucide.min.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
```

O mejor: descargar el archivo y servirlo localmente desde `/static/js/`.

---

## 11. Validación de input

### Resumen de validaciones

| Input | Validación | Ubicación |
|-------|-----------|-----------|
| Nombre de cliente | `^[a-zA-Z0-9_-]+$` | `clients.py:168, 232` |
| Nombre de grupo | Regex sanitización | `groups.py:56-57` |
| Archivo download | `[^a-zA-Z0-9_-]` stripped | `clients.py:276` |
| Password login | Sin validación | `auth.py:36` |
| Group icon | Sin validación server-side | `groups.py:67` |

### Riesgo menor

El campo `icon` del grupo (1-2 letras) no se valida en el backend. Se renderiza via `esc()` en JS (seguro contra XSS), pero debería validarse en servidor por consistencia.

```python
icon = data.get('icon', 'AB')[:2].upper()
if not re.match(r'^[A-Z]{1,2}$', icon):
    icon = 'AB'
```

---

## Plan de acción priorizado

### Inmediato (antes de agregar más funcionalidad)

| # | Acción | Impacto | Esfuerzo |
|---|--------|---------|----------|
| 1 | Reemplazar `==` con `hmac.compare_digest()` en auth.py | Alto | 2 min |
| 2 | Agregar security headers (`after_request`) en app.py | Alto | 5 min |
| 3 | Fijar versión de Lucide en index.html | Medio | 2 min |

### Corto plazo (esta semana)

| # | Acción | Impacto | Esfuerzo |
|---|--------|---------|----------|
| 4 | Rate limit en `/api/create` y `/api/revoke` | Medio | 5 min |
| 5 | Validar `VOLUME_NAME` con regex en config.py | Bajo | 2 min |
| 6 | Validar `icon` en backend (groups.py) | Bajo | 2 min |
| 7 | Servir Lucide localmente en vez de CDN | Medio | 10 min |

### Opcional (si el proyecto escala)

| # | Acción | Impacto | Esfuerzo |
|---|--------|---------|----------|
| 8 | Migrar ADMIN_PASSWORD a hash con argon2 | Alto | 30 min |
| 9 | Usar GCP Secret Manager en vez de `.env` | Alto | 1-2 hrs |
| 10 | Agregar login audit log (IP, timestamp, resultado) | Medio | 20 min |
| 11 | Implementar session idle timeout (no solo TTL fijo) | Bajo | 15 min |

---

## Conclusión

La aplicación tiene una **base de seguridad sólida**: CSRF bien implementado, input validation con regex allowlist, subprocess sin shell injection, cookies con flags correctos, y todas las rutas protegidas con auth.

Las debilidades principales son **headers HTTP faltantes** y **comparación de password insegura** — ambas solucionables en minutos. El riesgo real es bajo dado que la superficie de ataque es limitada (solo admins acceden, SSH solo via IAP, sin acceso público al Docker socket).

---

*Auditoría basada en OWASP Top 10, Flask Security Best Practices, y análisis estático de 11 archivos Python + templates + JS.*
