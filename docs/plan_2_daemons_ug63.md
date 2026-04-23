# Plan — Segundo daemon OpenVPN para clientes con OpenVPN 2.5+ (UG63v2 y futuros)

**Estado:** Propuesta — no ejecutar hasta aprobación explícita.
**Fecha plan:** 2026-04-23
**Autor contexto:** diagnóstico completo en `docs/fix_comp_lzo_ug63.md` + respuesta Milesight en `logs-errores/milesight support/Second response.docx`.

---

## 1. Contexto

### 1.1 Problema confirmado

| Modelo | Firmware OpenVPN | Acepta `comp-lzo no` en PUSH_REPLY | Inserta byte framing en data channel |
|---|---|---|---|
| UG67 / UG65 / UG56 | 2.4.0 | Sí | Sí |
| **UG63v2** (WILO, `035-1-GW002`) | **2.6.13** | **No** (rechaza con `Options error: ... [PUSH-OPTIONS]:1: comp-lzo (1)`) | **No** (firmware compilado sin comp) |
| Server actual | 2.4.9 (kylemanna/openvpn) | N/A | Espera el byte (`comp-lzo no` en config) |

Resultado: WILO entra en loop handshake OK → data channel rompe → `ping-restart` → reconnect infinito. Admin UI inaccesible.

Milesight confirma en su respuesta (ver `Second response.docx`): "Starting from OpenVPN version 2.5.x, the `comp-lzo` parameter has been removed... the best solution is to enable two sets of OpenVPN server configuration files."

### 1.2 Intentos previos descartados

1. **Quitar `comp-lzo no` + `push "comp-lzo no"` global del server** → UG63 funciona, UG67 rompen (firmware 2.4.0 sigue insertando byte que server ya no espera). Rollback hecho 2026-04-16.
2. **Agregar `comp-lzo no` al `.ovpn` del UG63** → `Options error: Unrecognized option ... comp-lzo (1)`.
3. **Agregar `compress` al `.ovpn` del UG63** → `Options error: Compression or compression stub framing is not allowed since OpenVPN was built without compression support.`
4. **Agregar `ignore-unknown-option comp-lzo` + `allow-compression yes` al `.ovpn` del UG63** (sugerencia Milesight) → parser no aborta pero UG63 sigue sin insertar byte → `Bad compression stub decompression header byte: 42` sigue.

### 1.3 Objetivo

- Mantener UG67/UG65/UG56 conectando sin cambios (prod estable).
- WILO (UG63v2) funcional end-to-end: admin panel accede UI del gateway.
- Agregar futuros clientes UG63 o nuevos modelos con OpenVPN 2.5+ sin más refactors.
- Preservar aislamiento por grupo (admin ve todo, grupos solo se ven entre sí).
- Admin panel detecta modelo en alta de cliente y rutea al daemon correcto.

---

## 2. Diseño — Arquitectura

### 2.1 Dos daemons, misma VM, PKI compartida

```
                         vpn-prod-vm (GCP)
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│  ┌────────────────────┐          ┌─────────────────────────┐       │
│  │  openvpn           │          │  openvpn-modern (NEW)   │       │
│  │  kylemanna 2.4.9   │          │  kylemanna 2.4.9        │       │
│  │  port 1194/udp     │          │  port 1195/udp          │       │
│  │  subnet 10.8.0.0/16│          │  subnet 10.9.0.0/16     │       │
│  │  comp-lzo no       │          │  SIN comp-lzo           │       │
│  │  tun0              │          │  tun1                   │       │
│  │                    │          │                         │       │
│  │  Clientes:         │          │  Clientes:              │       │
│  │  - UG67            │          │  - UG63v2               │       │
│  │  - UG65            │          │  - (futuros OpenVPN 2.5+)│      │
│  │  - UG56            │          │                         │       │
│  │  - Desktops admin  │          │                         │       │
│  └─────────┬──────────┘          └────────────┬────────────┘       │
│            │ bind-mount                       │ bind-mount         │
│            └───────────┬───────────────────────┘                   │
│                        │                                           │
│              ┌─────────▼──────────┐                                │
│              │  /mnt/vpn-data/    │                                │
│              │    openvpn/pki/    │  ← PKI ÚNICA COMPARTIDA        │
│              │    ccd/            │  ← CCD daemon1                 │
│              │    ccd-modern/     │  ← CCD daemon2 (nuevo)         │
│              │    clients/        │  ← .ovpn (ambos daemons)       │
│              │    openvpn.conf    │  ← config daemon1              │
│              │    openvpn-modern.conf │ ← config daemon2 (nuevo)   │
│              └─────────────────────┘                               │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  openvpn-admin  (Flask)                                      │   │
│  │  - Detecta model en alta → rutea a daemon correcto           │   │
│  │  - Lee ambos status log                                       │   │
│  │  - Envía SIGHUP a ambos containers en revoke                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 ¿Por qué host networking para los daemons?

Los dos daemons deben compartir el kernel routing table para que un cliente UG67 en `tun0` (daemon1) pueda hablar con un cliente UG63 en `tun1` (daemon2) del mismo grupo. Con Docker bridge networking, `tun0` y `tun1` están en netns separados → el kernel del host no las ve → no hay `FORWARD` posible entre ellas.

**Solución:** `network_mode: host` en ambos containers openvpn. Ambos tun devices aparecen en el host → una única tabla `iptables FORWARD` en el host controla todo.

**Cuidado crítico:** el comando actual de `openvpn` container hace `iptables -F FORWARD` (flush). Si se ejecuta en netns del host, **rompe Docker, ufw y todos los otros containers**. Hay que reescribir la estrategia iptables a una **custom chain** (ver §5).

---

## 3. Esquema IP / subnets / puertos

### 3.1 Subnet allocation

| Daemon | Subnet | Server IP | Pool clientes | Grupo N → IP |
|---|---|---|---|---|
| `openvpn` (1194) | `10.8.0.0/16` | `10.8.0.1` | `10.8.0.2` – `10.8.255.254` | `10.8.N.x` |
| `openvpn-modern` (1195) | `10.9.0.0/16` | `10.9.0.1` | `10.9.0.2` – `10.9.255.254` | `10.9.N.x` |

- Admins solo existen en daemon1 (`10.8.0.x`) — los desktops admin (Windows/Mac) usan OpenVPN Connect que soporta comp-lzo, no hace falta daemon moderno.
- UG63v2 en grupo `wilo` (group_num=8) → IP `10.9.8.1` (no más `10.8.8.1`).

### 3.2 Routing cross-subnet

**daemon1 `openvpn.conf` agrega:**
```
push "route 10.9.0.0 255.255.0.0"
route 10.9.0.0 255.255.0.0
```
→ admins (y cualquier otro cliente de daemon1) rutean `10.9.x` vía `10.8.0.1` → host → `tun1` → daemon2 → UG63.

**daemon2 `openvpn-modern.conf` agrega:**
```
push "route 10.8.0.0 255.255.0.0"
route 10.8.0.0 255.255.0.0
```
→ UG63 rutea `10.8.x` vía `10.9.0.1` → host → `tun0` → daemon1 → UG67.

### 3.3 Puertos

| Puerto | Daemon | GCP firewall rule |
|---|---|---|
| 1194/udp | openvpn (existente) | `vpn-prod-fw-openvpn` — ya existe |
| 1195/udp | openvpn-modern (nuevo) | **nueva regla** — `vpn-prod-fw-openvpn-modern` |

Terraform `infra/firewall.tf` — nueva regla `google_compute_firewall` permitiendo `1195/udp` desde `0.0.0.0/0`.

También `infra/scripts/startup.sh` agrega `ufw allow 1195/udp`.

---

## 4. PKI compartida

### 4.1 ¿Por qué compartida?

Si cada daemon tuviera su propio PKI:
- El admin panel tendría que manejar dos CA separados.
- Un mismo cliente (ej: `035-1-GW002`) no podría migrar entre daemons.
- Duplicación de complejidad.

PKI única (misma CA, misma `ta.key`, mismo CRL) → cualquier cert firmado se valida en ambos daemons.

### 4.2 Mecanismo

Ambos containers montan `openvpn_openvpn_data` (el volumen existente) en `/etc/openvpn`. kylemanna/openvpn usa `/etc/openvpn/pki/*` y lee `/etc/openvpn/openvpn.conf` por default — daemon2 se ejecuta con `--config /etc/openvpn/openvpn-modern.conf` y `--client-config-dir /etc/openvpn/ccd-modern`.

### 4.3 CRL compartida

`/etc/openvpn/crl.pem` es regenerado por `easyrsa revoke <CN>` + `easyrsa gen-crl`. Ambos daemons leen el mismo archivo (mismo volumen). Al revocar: enviar `SIGHUP` a ambos containers para recargar CRL.

### 4.4 Riesgo: race conditions en escritura PKI

Escritura concurrente a `/etc/openvpn/pki/` desde dos containers (emisión de cert + revoke simultáneo) puede corromper el índice de easyrsa.

**Mitigación:** el admin panel (único escritor) serializa todas las operaciones PKI. Los daemons solo leen. No hay problema real.

---

## 5. iptables — estrategia custom chain

### 5.1 Objetivos

- Admin group (`10.8.0.0/24`) ve todo en 10.8/16 y 10.9/16.
- Grupo N dentro del mismo daemon se ve: `10.8.N.0/24` ↔ `10.8.N.0/24`, `10.9.N.0/24` ↔ `10.9.N.0/24`.
- Grupo N cross-daemon se ve: `10.8.N.0/24` ↔ `10.9.N.0/24`.
- Todo lo demás cliente↔cliente: DROP.
- Tráfico VPN↔internet (NAT): inalterado.

### 5.2 Implementación — custom chain `OPENVPN_FWD`

Creada y mantenida por un script que corre **en el host** (fuera de los containers openvpn). Ubicación: `infra/scripts/openvpn-iptables.sh`, llamado desde `startup.sh` tras levantar los containers.

```bash
#!/bin/bash
set -euo pipefail

CHAIN="OPENVPN_FWD"

# Crear chain si no existe (idempotente)
iptables -N $CHAIN 2>/dev/null || iptables -F $CHAIN

# Enganchar chain a FORWARD (una sola vez)
iptables -C FORWARD -j $CHAIN 2>/dev/null || iptables -I FORWARD 1 -j $CHAIN

# 1. Conntrack — permitir respuestas establecidas
iptables -A $CHAIN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# 2. Admin ve todo (source 10.8.0.0/24)
iptables -A $CHAIN -s 10.8.0.0/24 -o tun+ -j ACCEPT

# 3. Mismo grupo en daemon1 (10.8.N.x ↔ 10.8.N.x)
for i in $(seq 1 255); do
  iptables -A $CHAIN -s 10.8.$i.0/24 -d 10.8.$i.0/24 -j ACCEPT
done

# 4. Mismo grupo en daemon2 (10.9.N.x ↔ 10.9.N.x)
for i in $(seq 1 255); do
  iptables -A $CHAIN -s 10.9.$i.0/24 -d 10.9.$i.0/24 -j ACCEPT
done

# 5. Mismo grupo cross-daemon (10.8.N.x ↔ 10.9.N.x)
for i in $(seq 1 255); do
  iptables -A $CHAIN -s 10.8.$i.0/24 -d 10.9.$i.0/24 -j ACCEPT
  iptables -A $CHAIN -s 10.9.$i.0/24 -d 10.8.$i.0/24 -j ACCEPT
done

# 6. Drop cualquier otro tun+ ↔ tun+
iptables -A $CHAIN -i tun+ -o tun+ -j DROP

# (NAT VPN → internet lo maneja Docker por default; no tocamos POSTROUTING)
```

### 5.3 Diferencias vs. iptables actual

- **No** usa `-F FORWARD` — solo crea/llena `OPENVPN_FWD` sin tocar las reglas de Docker.
- **No** usa `-P FORWARD DROP` — deja la política default (ACCEPT de Docker).
- El `DROP` final del chain custom es el que aplica solo a tráfico tun↔tun.
- El tráfico tun↔eth0 (NAT a internet) pasa por `OPENVPN_FWD` sin match → vuelve a `FORWARD` → match en reglas Docker existentes → ACCEPT.

### 5.4 Remover el comando iptables del `docker-compose.yml` `openvpn` container

Con el nuevo esquema host-mode, **NO** queremos que el container corra `iptables -F FORWARD`. Hay que reemplazar el `command:` del container por solo `ovpn_run` sin el pipeline de iptables.

---

## 6. Cambios en `docker-compose.yml`

### 6.1 Container `openvpn` (modificado)

```yaml
openvpn:
  image: kylemanna/openvpn
  container_name: openvpn
  restart: always
  network_mode: host          # CAMBIO: era bridge con ports
  cap_add:
    - NET_ADMIN
  volumes:
    - openvpn_openvpn_data:/etc/openvpn
    - ./ccd:/etc/openvpn/ccd
  # Ya no: ports, sysctls (host ya tiene ip_forward=1 desde startup.sh)
  command: ovpn_run --config /etc/openvpn/openvpn.conf --port 1194
```

### 6.2 Container `openvpn-modern` (nuevo)

```yaml
openvpn-modern:
  image: kylemanna/openvpn
  container_name: openvpn-modern
  restart: always
  network_mode: host
  cap_add:
    - NET_ADMIN
  volumes:
    - openvpn_openvpn_data:/etc/openvpn    # MISMO volumen — PKI compartida
    - ./ccd-modern:/etc/openvpn/ccd-modern
  command: >
    ovpn_run
    --config /etc/openvpn/openvpn-modern.conf
    --client-config-dir /etc/openvpn/ccd-modern
    --port 1195
    --dev tun1
```

### 6.3 Container `openvpn-admin` — sin cambios de networking

Sigue en bridge (`admin_net` + `default`), conectado a `docker-socket-proxy` y `traefik`. El code del admin ahora tiene que saber que los containers openvpn están en host mode — eso no afecta cómo los comanda vía Docker CLI (`docker exec openvpn ...` y `docker exec openvpn-modern ...`). Sigue funcionando.

### 6.4 `openvpn-admin` `depends_on`

Agregar `openvpn-modern` a `depends_on`:

```yaml
depends_on:
  - openvpn
  - openvpn-modern
  - docker-socket-proxy
```

---

## 7. Archivo `openvpn-modern.conf`

Generado una sola vez con `ovpn_genconfig` dentro del container — exactamente como ya se hace para daemon1 en `startup.sh`, pero con:

- `-u udp://${PUBLIC_IP}:1195`
- `-s 10.9.0.0/16`
- `-p "route 10.8.0.0 255.255.0.0"` (push al cliente)
- `-e "topology subnet"`
- `-e "route 10.8.0.0 255.255.0.0"` (route en server para retorno)

Luego `sed` post-generación para dejar limpio:

```bash
# Eliminar cualquier comp-lzo / push comp-lzo (kylemanna los mete por default)
sed -i '/^comp-lzo/d' /mnt/vpn-data/openvpn/openvpn-modern.conf
sed -i '/^push "comp-lzo/d' /mnt/vpn-data/openvpn/openvpn-modern.conf

# Eliminar block-outside-dns y dhcp-option DNS (igual que daemon1 actual)
sed -i '/block-outside-dns/d' /mnt/vpn-data/openvpn/openvpn-modern.conf
sed -i '/dhcp-option DNS/d' /mnt/vpn-data/openvpn/openvpn-modern.conf

# Apuntar certs/keys al PKI compartido (mismos paths que daemon1, ya que montan mismo /etc/openvpn)
# ovpn_genconfig ya los pone correctamente.

# Verificar que use el mismo nombre de cert que daemon1 — debería ser el hostname/IP:
# cert /etc/openvpn/pki/issued/34.44.29.193.crt
# key  /etc/openvpn/pki/private/34.44.29.193.key
```

### 7.1 Validación que daemon2 usa el mismo cert server

Antes de arrancar daemon2 confirmar:
- `/etc/openvpn/pki/issued/34.44.29.193.crt` existe
- `/etc/openvpn/pki/private/34.44.29.193.key` existe

Si existe → no re-emitir. Ambos daemons usan el mismo cert server (válido porque ambos responden a la misma IP pública).

### 7.2 ta.key compartida

`/etc/openvpn/pki/ta.key` ya existe. `openvpn-modern.conf` la referencia igual que `openvpn.conf`. Clientes emitidos con el mismo ta.key — válido en ambos daemons.

---

## 8. Cambios en Admin panel

### 8.1 Schema `clients.json`

**Antes:**
```json
{
  "clients": {
    "035-1-GW002": { "group": "wilo", "ip": "10.8.8.1" }
  }
}
```

**Después:**
```json
{
  "clients": {
    "035-1-GW002": {
      "group": "wilo",
      "ip": "10.9.8.1",
      "model": "UG63v2",
      "daemon": "modern"
    },
    "000-1-GW001": {
      "group": "wedo",
      "ip": "10.8.1.1",
      "model": "UG67",
      "daemon": "classic"
    }
  }
}
```

Nuevos campos por cliente:
- `model`: `UG67` | `UG65` | `UG56` | `UG63v2` | `Desktop` | `Other`
- `daemon`: `classic` (1194, 10.8/16) | `modern` (1195, 10.9/16)

**Mapping modelo → daemon:**

| Modelo | Daemon |
|---|---|
| UG67, UG65, UG56, Desktop, Other | `classic` |
| UG63v2 | `modern` |

### 8.2 Migración schema (una sola vez, al primer deploy)

Script `admin/migrate_clients_json.py` — corre al boot del admin container si `clients.json` no tiene `model`/`daemon` en ningún cliente:

```python
for client_name, data in clients.items():
    if "daemon" not in data:
        data["daemon"] = "classic"   # todos los existentes asumen daemon1
        data["model"] = "UG67"       # guess seguro para los actuales (todos UG67)
```

Después de migrar, el usuario puede editar desde la UI cualquier cliente que realmente sea UG65/UG56/Desktop si le importa la distinción. Lo crítico es que todos queden en daemon `classic`, lo cual es correcto.

### 8.3 Endpoints API afectados (`admin/app.py`)

#### 8.3.1 `POST /api/clients` (crear cliente)

Antes: recibe `{name, group}` → emite cert → genera .ovpn.

Después: recibe `{name, group, model}` → deriva `daemon` → asigna IP en subnet correcta → shell out al container correcto → CCD en dir correcto → `.ovpn` con port correcto.

Pseudocódigo:

```python
MODEL_TO_DAEMON = {
    "UG67": "classic", "UG65": "classic", "UG56": "classic",
    "Desktop": "classic", "Other": "classic",
    "UG63v2": "modern",
}
DAEMON_CONFIG = {
    "classic": {
        "container": "openvpn",
        "subnet_prefix": "10.8",
        "port": 1194,
        "ccd_dir": "/app/ccd",
        "ovpn_template_extra": "",   # nada especial
    },
    "modern": {
        "container": "openvpn-modern",
        "subnet_prefix": "10.9",
        "port": 1195,
        "ccd_dir": "/app/ccd-modern",
        "ovpn_template_extra": "ignore-unknown-option comp-lzo\nallow-compression yes\n",
    },
}

def create_client(name, group, model):
    daemon = MODEL_TO_DAEMON[model]
    cfg = DAEMON_CONFIG[daemon]

    # 1. Next IP en subnet correcta
    group_num = groups[group]["group_num"]
    next_client = groups[group].get(f"next_client_{daemon}", 1)
    ip = f"{cfg['subnet_prefix']}.{group_num}.{next_client}"

    # 2. Emitir cert (PKI compartida, container1 OK para ambos)
    docker_exec("openvpn", f"easyrsa build-client-full {name} nopass")

    # 3. Generar .ovpn → reemplazar port según daemon, agregar ovpn_template_extra
    ovpn_content = generate_ovpn(name, port=cfg["port"], extra=cfg["ovpn_template_extra"])
    write_file(f"/app/clients/{name}.ovpn", ovpn_content)

    # 4. CCD en dir correcto
    write_file(f"{cfg['ccd_dir']}/{name}", f"ifconfig-push {ip} 255.255.0.0")

    # 5. Guardar en clients.json
    clients[name] = {"group": group, "ip": ip, "model": model, "daemon": daemon}
    groups[group][f"next_client_{daemon}"] = next_client + 1
    save_clients_json()
```

Nota: cada grupo ahora tiene **dos** contadores (`next_client_classic`, `next_client_modern`) para permitir que un mismo grupo tenga UG67 y UG63 coexistiendo sin colisión de IPs.

#### 8.3.2 `GET /api/connections` (status)

Unificar lectura de ambos status logs:

```python
def get_connections():
    result = []
    for daemon, cfg in DAEMON_CONFIG.items():
        log = docker_exec(cfg["container"], "cat /tmp/openvpn-status.log")
        for line in parse_status(log):
            line["daemon"] = daemon   # tag
            result.append(line)
    return result
```

#### 8.3.3 `POST /api/clients/<name>/revoke`

Revocar cert (PKI compartida, una sola vez) → SIGHUP a **ambos** containers para recargar CRL:

```python
def revoke_client(name):
    docker_exec("openvpn", f"easyrsa revoke {name}")
    docker_exec("openvpn", "easyrsa gen-crl")
    docker_exec("openvpn", "cp pki/crl.pem /etc/openvpn/crl.pem")
    # SIGHUP ambos containers
    docker_signal("openvpn", "SIGHUP")
    docker_signal("openvpn-modern", "SIGHUP")
    # Borrar del clients.json y archivos locales
    del clients[name]
    remove_file(f"/app/clients/{name}.ovpn")
    daemon = clients[name]["daemon"]
    ccd_dir = DAEMON_CONFIG[daemon]["ccd_dir"]
    remove_file(f"{ccd_dir}/{name}")
    save_clients_json()
```

#### 8.3.4 Helper `docker_exec` actualizado

Hoy: `docker exec openvpn ...`. Necesita aceptar container name como parámetro. Ya debería aceptarlo — si no, 1 refactor menor.

### 8.4 Cambios UI

#### 8.4.1 `admin/templates/index.html` — formulario crear cliente

Agregar dropdown "Modelo" arriba de "Grupo":

```html
<div class="form-group">
  <label for="new-client-model">Modelo</label>
  <select id="new-client-model" required>
    <option value="UG67" selected>Milesight UG67</option>
    <option value="UG65">Milesight UG65</option>
    <option value="UG56">Milesight UG56</option>
    <option value="UG63v2">Milesight UG63v2</option>
    <option value="Desktop">Desktop / laptop</option>
    <option value="Other">Otro</option>
  </select>
  <small class="hint" id="daemon-hint">Se conectará al daemon <code>classic</code> (puerto 1194, subred 10.8.x.x).</small>
</div>
```

Event listener JS actualiza el `<small>` según la selección (muestra `classic` o `modern`). Feedback inmediato al usuario.

#### 8.4.2 Tabla de clientes — columnas nuevas

Agregar columnas "Modelo" y "Daemon" (esta última opcional, como badge gris chiquito).

```html
<th>Nombre</th>
<th>Grupo</th>
<th>IP</th>
<th>Modelo</th>        <!-- NUEVA -->
<th>Estado</th>
<th>Acciones</th>
```

Badge daemon en la celda Modelo:
```html
<span class="model">UG63v2</span>
<span class="badge badge-modern">modern</span>
```

CSS:
```css
.badge { padding: 2px 6px; border-radius: 4px; font-size: 0.75em; }
.badge-classic { background: #e0e0e0; color: #444; }
.badge-modern  { background: #d4edda; color: #155724; }
```

#### 8.4.3 Edit cliente

Permitir cambiar modelo de un cliente existente **solo si se revoca y reemite** (cambio de modelo → cambio de daemon → cambio de IP → cambio de .ovpn). Mostrar confirmación:

> Cambiar el modelo de un cliente requiere revocar el certificado actual y emitir uno nuevo con IP del daemon correspondiente. El cliente quedará desconectado hasta que se suba el nuevo `.ovpn` al gateway. ¿Continuar?

#### 8.4.4 Status dashboard — agrupación

El listado de "Clientes conectados" ahora muestra clientes de ambos daemons. Diferenciar visualmente con el badge (classic/modern) o separar en dos secciones si da más claridad.

---

## 9. Cambios en infra (Terraform + startup.sh)

### 9.1 `infra/firewall.tf`

Agregar regla:

```hcl
resource "google_compute_firewall" "openvpn_modern" {
  name    = "vpn-prod-fw-openvpn-modern"
  network = google_compute_network.vpn.name

  allow {
    protocol = "udp"
    ports    = ["1195"]
  }
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["vpn-server"]
}
```

### 9.2 `infra/scripts/startup.sh` — cambios

#### 9.2.1 Paso `[3/8]` ufw

Agregar `ufw allow 1195/udp`.

#### 9.2.2 Paso `[9/9]` init PKI — generar daemon2 config

Después del `ovpn_initpki` existente, generar config del daemon2 si no existe:

```bash
DAEMON2_CONF="${DATA_DIR}/openvpn/openvpn-modern.conf"
if [ ! -f "$DAEMON2_CONF" ]; then
  echo "  Generando openvpn-modern.conf..."
  docker compose run --rm openvpn ovpn_genconfig \
    -u "udp://${PUBLIC_IP}:1195" \
    -s "10.9.0.0/16" \
    -e "topology subnet" \
    -p "route 10.8.0.0 255.255.0.0" \
    -r "10.8.0.0 255.255.0.0"

  # ovpn_genconfig escribe a openvpn.conf — hay que renombrarlo
  mv "${DATA_DIR}/openvpn/openvpn.conf.tmp" "$DAEMON2_CONF"  # o lo que genere

  # Sanear
  sed -i '/^comp-lzo/d' "$DAEMON2_CONF"
  sed -i '/^push "comp-lzo/d' "$DAEMON2_CONF"
  sed -i '/block-outside-dns/d' "$DAEMON2_CONF"
  sed -i '/dhcp-option DNS/d' "$DAEMON2_CONF"

  echo "  openvpn-modern.conf generado"
fi
```

> **Nota:** `ovpn_genconfig` del image kylemanna siempre genera `openvpn.conf`. Para generar un segundo config hay que trabajar con un volumen temporal y después mover. Alternativa más simple: copiar `openvpn.conf` existente, patchearlo (cambiar `server`, `port`, `dev`, routes, quitar comp-lzo) y guardarlo como `openvpn-modern.conf`. Menos dependencias.

#### 9.2.3 Paso nuevo: inicializar iptables chain custom

Antes de `docker compose up -d`, correr `openvpn-iptables.sh` para crear/llenar `OPENVPN_FWD`:

```bash
echo "[10/10] Configurando iptables OPENVPN_FWD..."
bash /opt/vpn/infra/scripts/openvpn-iptables.sh
echo "  OPENVPN_FWD listo"
```

El script es idempotente — si ya existe, flush y repobla. Se debe re-correr cada reboot (añadir a `cron @reboot` o a un systemd unit one-shot).

### 9.3 Crear `infra/scripts/openvpn-iptables.sh`

Ver código completo en §5.2.

---

## 10. Fases de implementación

### Fase 1 — Infra 2 daemons sin cambios admin (≈ 4-6h)

**Objetivo:** daemon2 corriendo en paralelo, WILO migrado manualmente, UG67 sin afectar.

**Tareas:**

1. Crear branch `feat/second-daemon-ug63`.
2. Agregar regla Terraform firewall 1195/udp → `terraform plan && terraform apply` (aplica sin tocar la VM).
3. En la VM:
   - [ ] Backup de `/mnt/vpn-data/openvpn/openvpn.conf` → `.bak-phase1`.
   - [ ] Backup de `/etc/fstab`, `docker-compose.yml`, `iptables-save > /tmp/iptables-pre-phase1.rules`.
   - [ ] `mkdir -p /mnt/vpn-data/ccd-modern` con `chown 1000:1000`.
   - [ ] Copiar `openvpn.conf` como base de `openvpn-modern.conf`:
     ```bash
     sudo cp /mnt/vpn-data/openvpn/openvpn.conf /mnt/vpn-data/openvpn/openvpn-modern.conf
     sudo sed -i 's|server 10.8.0.0 255.255.0.0|server 10.9.0.0 255.255.0.0|' /mnt/vpn-data/openvpn/openvpn-modern.conf
     sudo sed -i 's|^port 1194|port 1195|' /mnt/vpn-data/openvpn/openvpn-modern.conf
     sudo sed -i 's|^dev tun0|dev tun1|' /mnt/vpn-data/openvpn/openvpn-modern.conf
     sudo sed -i '/^comp-lzo/d' /mnt/vpn-data/openvpn/openvpn-modern.conf
     sudo sed -i '/^push "comp-lzo/d' /mnt/vpn-data/openvpn/openvpn-modern.conf
     # agregar routes cross-subnet al final
     echo 'route 10.8.0.0 255.255.0.0' | sudo tee -a /mnt/vpn-data/openvpn/openvpn-modern.conf
     echo 'push "route 10.8.0.0 255.255.0.0"' | sudo tee -a /mnt/vpn-data/openvpn/openvpn-modern.conf
     ```
   - [ ] Al `openvpn.conf` (daemon1) agregar push de ruta inversa:
     ```bash
     echo 'route 10.9.0.0 255.255.0.0' | sudo tee -a /mnt/vpn-data/openvpn/openvpn.conf
     echo 'push "route 10.9.0.0 255.255.0.0"' | sudo tee -a /mnt/vpn-data/openvpn/openvpn.conf
     ```
4. Modificar `docker-compose.yml`:
   - [ ] `openvpn` container → `network_mode: host`, quitar `ports`, quitar `sysctls`, cambiar `command:` quitando el pipeline de iptables (solo dejar `ovpn_run`).
   - [ ] Agregar `openvpn-modern` service (ver §6.2).
   - [ ] Agregar `openvpn-modern` a `depends_on` de `openvpn-admin`.
5. Instalar el script iptables en el host:
   - [ ] Copiar `infra/scripts/openvpn-iptables.sh` a `/opt/vpn/infra/scripts/`.
   - [ ] `chmod +x`.
   - [ ] Agregar a `cron @reboot` o crear `systemd` unit `openvpn-iptables.service`.
6. En la VM (durante ventana de mantenimiento, ≈ 2 min downtime):
   - [ ] `sudo systemctl stop docker` (sirve de "safe stop" antes de tocar host iptables)
   - [ ] **NO** correr el viejo `iptables -F FORWARD` — confirmar que queda limpio:
     ```bash
     sudo iptables-save | grep -A 20 '^:FORWARD'
     ```
   - [ ] `sudo bash /opt/vpn/infra/scripts/openvpn-iptables.sh`
   - [ ] `sudo systemctl start docker`
   - [ ] `sudo docker compose -f /opt/vpn/docker-compose.yml up -d --build`
7. Validar Fase 1 (ver §11.1).

**Checkpoint obligatorio:** antes de Fase 2, confirmar:
- UG67 (al menos 3 gateways) responden ping desde `10.8.0.1`.
- WILO con .ovpn manual a port 1195 responde ping desde `10.8.0.1` (admin) y desde `10.9.0.1` (server modern).
- Admin desktop conecta normal a daemon1, pingea 10.8.X.Y Y 10.9.8.1.
- UG67 en grupo wilo (si existiera) pingea 10.9.8.1 vía cross-daemon.
- Docker + otros containers (traefik, admin, docker-socket-proxy) siguen OK.

### Fase 2 — Admin panel aware (≈ 6-8h)

**Tareas:**

1. `admin/app.py`:
   - [ ] Constantes `MODEL_TO_DAEMON` y `DAEMON_CONFIG`.
   - [ ] `migrate_clients_json()` backfill — corre al startup de Flask si detecta falta de `daemon` en algún cliente.
   - [ ] `create_client` refactor con daemon routing.
   - [ ] `revoke_client` manda SIGHUP a ambos containers.
   - [ ] `get_connections` lee ambos status logs.
   - [ ] Helper `docker_exec(container, cmd)` refactor si hace falta.
   - [ ] `generate_ovpn` agrega `ovpn_template_extra` según daemon.
2. `admin/templates/index.html`:
   - [ ] Dropdown modelo en form de alta.
   - [ ] Columna Modelo en tabla.
3. `admin/static/app.js`:
   - [ ] Enviar `model` en POST de alta.
   - [ ] Hint dinámico "se conectará al daemon X".
   - [ ] Renderizar columna Modelo + badge daemon.
4. `admin/static/style.css`:
   - [ ] `.badge`, `.badge-classic`, `.badge-modern`.
5. `docker-compose.yml`:
   - [ ] Agregar bind-mount `./ccd-modern:/app/ccd-modern:rw` al container `openvpn-admin`.
6. Rebuild imagen admin: `docker compose build openvpn-admin && docker compose up -d openvpn-admin`.
7. Validar Fase 2 (ver §11.2).

### Fase 3 — Migración WILO (≈ 30min)

**Tareas:**

1. [ ] Desde admin UI: revocar `035-1-GW002`.
2. [ ] Desde admin UI: crear nuevo cliente `035-1-GW002` con grupo `wilo` + modelo `UG63v2`.
3. [ ] Verificar que el nuevo `.ovpn` tiene `remote 34.44.29.193 1195 udp`.
4. [ ] Descargar `.ovpn` y subirlo al UG63 (UI → Network → VPN → OpenVPN Client → Delete instance vieja → Import nuevo → Apply).
5. [ ] Esperar 30s para que el UG63 reconecte.
6. [ ] Verificar desde VM:
   ```bash
   sudo docker exec openvpn-modern cat /tmp/openvpn-status.log | grep 035-1-GW002
   sudo docker exec openvpn-modern ping -c 3 10.9.8.1
   ```
7. [ ] Verificar desde admin desktop (Guille-Admin-PC-Casa): `ping 10.9.8.1` y abrir `http://10.9.8.1` en navegador.
8. [ ] Actualizar memoria del proyecto (proyecto VPN) con el nuevo esquema.

---

## 11. Testing por fase

### 11.1 Tests Fase 1

| Test | Comando | Resultado esperado |
|---|---|---|
| Server daemon1 up | `sudo docker logs openvpn --tail 10` | `Initialization Sequence Completed` |
| Server daemon2 up | `sudo docker logs openvpn-modern --tail 10` | `Initialization Sequence Completed` |
| UG67 conectado | `sudo docker exec openvpn cat /tmp/openvpn-status.log \| grep GW001` | ≥ 3 clientes UG67 con RX/TX > 0 |
| Ping UG67 desde host | `sudo ping -c 3 10.8.1.1` | 3/3 respuestas |
| WILO conectado en daemon2 | `sudo docker exec openvpn-modern cat /tmp/openvpn-status.log \| grep 035-1-GW002` | 1 entrada |
| Ping WILO desde host | `sudo ping -c 3 10.9.8.1` | 3/3 respuestas |
| Sin `Bad compression` en daemon2 | `sudo docker logs openvpn-modern --tail 200 \| grep -c 'Bad compression'` | `0` |
| iptables chain OK | `sudo iptables -L OPENVPN_FWD -n -v` | ≥ 4 × 255 rules |
| Docker otros containers OK | `sudo docker ps --filter 'status=running'` | 4 containers up (openvpn, openvpn-modern, openvpn-admin, traefik, docker-socket-proxy) |
| Cross-daemon same group | Admin (10.8.0.4) hace `ping 10.9.8.1` desde desktop | Respuestas OK |
| Group isolation preservada | UG67 grupo A pingea UG67 grupo B (distinto) | 100% loss |

### 11.2 Tests Fase 2

| Test | Acción | Resultado esperado |
|---|---|---|
| Migración silenciosa | Boot admin container | Log Flask: `migrated N clients to schema v2` |
| Alta UG67 | UI: crear `TEST-UG67-01`, grupo `test`, modelo UG67 | IP `10.8.X.1`, `.ovpn` con `remote ... 1194`, CCD en `ccd/` |
| Alta UG63v2 | UI: crear `TEST-UG63-01`, grupo `test`, modelo UG63v2 | IP `10.9.X.1`, `.ovpn` con `remote ... 1195` + `ignore-unknown-option comp-lzo` + `allow-compression yes`, CCD en `ccd-modern/` |
| Mismo grupo diferentes daemons | Crear 1 UG67 y 1 UG63v2 en mismo grupo | Contadores `next_client_classic` y `next_client_modern` independientes |
| Status unificado | UI muestra ambos daemons en "Conectados" | Badges classic/modern visibles |
| Revoke | Revocar TEST-UG63-01 | Ambos daemons rechazan reconexión (CRL recargado) |
| Edit modelo | Cambiar modelo de TEST-UG67-01 a UG63v2 | Confirmación requerida; resultado: IP nueva 10.9, cert nuevo |

### 11.3 Tests Fase 3

| Test | Acción | Resultado esperado |
|---|---|---|
| WILO reconectado | Subir nuevo .ovpn al UG63 | UI UG63 muestra "Connected" estable >5min |
| Acceso UI UG63 | Abrir `http://10.9.8.1` desde Guille-Admin-PC-Casa | Login prompt del UG63 carga |
| Ping sostenido | `ping 10.9.8.1` desde admin | ≥ 99% respuestas en 5min |
| Logs limpios | `sudo docker logs openvpn-modern --since 10m \| grep -c 'Bad compression'` | `0` |

---

## 12. Rollback por fase

### 12.1 Rollback Fase 1

**Disparador:** Fase 1 tests fallan (UG67 no conectan, Docker roto, ambos daemons inestables).

**Prerrequisitos (obligatorio ANTES de 1b — sin esto el rollback pierde datos):**

```bash
# En la VM:
sudo iptables-save > /tmp/iptables-pre-phase1.rules
sudo cp /mnt/vpn-data/openvpn/openvpn.conf /mnt/vpn-data/openvpn/openvpn.conf.bak-phase1
sudo cp /opt/vpn/docker-compose.yml /opt/vpn/docker-compose.yml.bak-phase1

# "Boton rojo" opcional — snapshot completo del disco de datos:
gcloud compute disks snapshot vpn-prod-data \
  --snapshot-names=pre-phase1-$(date +%Y%m%d%H%M) \
  --zone=us-central1-a
```

**Pasos rollback (~3-5min downtime):**

1. **Bajar ambos containers:**
   ```bash
   cd /opt/vpn && sudo docker compose down
   ```

2. **Desenganchar y borrar chain iptables host + restaurar backup:**
   ```bash
   sudo iptables -D FORWARD -j OPENVPN_FWD 2>/dev/null || true
   sudo iptables -F OPENVPN_FWD 2>/dev/null || true
   sudo iptables -X OPENVPN_FWD 2>/dev/null || true
   sudo iptables-restore < /tmp/iptables-pre-phase1.rules
   ```

3. **Deshabilitar systemd unit (evita re-ejecucion en reboot):**
   ```bash
   sudo systemctl disable --now openvpn-iptables.service
   sudo rm -f /etc/systemd/system/openvpn-iptables.service
   sudo systemctl daemon-reload
   ```

4. **Rollback codigo del repo a master:**
   ```bash
   cd /opt/vpn && sudo git checkout master
   ```

5. **Restaurar `openvpn.conf` desde backup** (las routes `10.9.0.0` viven en el volumen, no en el repo — `git checkout` no las toca):
   ```bash
   sudo cp /mnt/vpn-data/openvpn/openvpn.conf.bak-phase1 /mnt/vpn-data/openvpn/openvpn.conf
   ```

6. **Archivos muertos (opcional — no molestan si se dejan):**
   ```bash
   sudo rm -f /mnt/vpn-data/openvpn/openvpn-modern.conf
   sudo rm -rf /mnt/vpn-data/ccd-modern
   sudo rm -f /opt/vpn/ccd-modern  # symlink
   ```

7. **Levantar servicios con master:**
   ```bash
   cd /opt/vpn && sudo docker compose up -d
   ```

8. **Verificar:**
   ```bash
   sudo docker ps --filter name=openvpn
   sudo docker logs openvpn --tail 20 | grep 'Initialization Sequence Completed'
   sleep 60
   sudo docker exec openvpn cat /tmp/openvpn-status.log | grep CLIENT_LIST
   sudo ping -c 3 10.8.1.1   # cualquier UG67 conocido
   ```

**Limpieza opcional de infra extra** (no rompen nada si se dejan):

```bash
# En local, revertir firewall GCP:
cd infra && terraform plan   # veras: destruira vpn_udp_modern
terraform apply              # si queres efectivo

# En VM, quitar ufw 1195:
sudo ufw delete allow 1195/udp
```

**Casos rapidos:**

| Sintoma 1b | Accion rapida |
|---|---|
| UG67 no reconecta al 1194 | Pasos 1-8 |
| Docker roto, otros containers caidos (traefik/admin) | Empezar por paso 2 (iptables) — suele ser la causa |
| Solo daemon2 roto pero daemon1 OK | No rollback total: `sudo docker compose stop openvpn-modern` y seguir con Fase 2 desactivada |
| VM no bootea tras reboot | Restaurar desde snapshot GCP (`gcloud compute disks restore-snapshot`) |

---

### 12.1.1 Nota critica — Terraform apply NO replace la VM

`metadata_startup_script` en `google_compute_instance` tiene `ForceNew` — cualquier edit a `infra/scripts/startup.sh` disparaba replace completo de la VM (downtime 10-20min, pierde boot disk). Fase 1 incluye fix en `infra/compute.tf`:

```hcl
lifecycle {
  ignore_changes = [
    metadata_startup_script,
    boot_disk[0].initialize_params[0].image,
  ]
}
```

Con este fix, `terraform apply` en Fase 1 **solo** crea la regla firewall `vpn_udp_modern`. No toca la VM.

**Tradeoff aceptado:** cambios futuros a `startup.sh` no se propagan via Terraform — hay que aplicarlos manual via SSH en la VM ya bootstrapped, o forzar con `terraform taint google_compute_instance.vpn_vm` seguido de apply (destruye VM nueva). El flujo real ya es SSH-y-aplicar, asi que el tradeoff es correcto.

### 12.2 Rollback Fase 2

**Disparador:** admin panel rompe alta/edición/revoke; UG67/UG63 existentes siguen OK en los daemons.

**Pasos:**
1. `git revert <commits-fase-2>` (no tocar Fase 1).
2. `docker compose build openvpn-admin && docker compose up -d openvpn-admin`.
3. `clients.json` con campos extra (`model`, `daemon`) — **no** hace falta revertir el schema; el código viejo ignora esos campos (Flask dict). Dejar así.
4. Verificar que `/api/clients` y alta tradicional funcionan.

### 12.3 Rollback Fase 3

**Disparador:** UG63 no funciona con el nuevo esquema ni aún con el daemon moderno (muy improbable llegado este punto).

**Pasos:**
1. Revocar el nuevo cert de WILO desde admin UI.
2. Re-crear WILO con modelo UG67 (queda en daemon1, IP 10.8.8.1) — sabemos que queda roto pero al menos vuelve al estado anterior.
3. **Alternativa mejor:** dejar WILO roto (como ya estaba) e investigar firmware alternativa con Milesight. No hacer rollback de Fases 1-2 — el valor del plan está instalado.

---

## 13. Riesgos conocidos

### 13.1 iptables en host — riesgo alto

Cambio más peligroso del plan. El actual comando del container openvpn hace `iptables -F FORWARD` en su netns, eso ya no será aceptable en host mode. La migración **debe** hacerse en ventana de mantenimiento con backup `iptables-save` antes.

**Mitigación:** el script `openvpn-iptables.sh` es idempotente y no toca `FORWARD` directamente — solo crea `OPENVPN_FWD` y la engancha una vez. Los otros containers quedan intactos.

### 13.2 Race condition en PKI compartida

Si el admin panel serializa operaciones (1 lock Python), no hay problema. Hoy `admin/app.py` no tiene locks explícitos — 1 request a la vez por cómo corre Flask en modo sync. Confirmar en el código antes de multi-worker.

### 13.3 `ovpn_genconfig` de kylemanna sobrescribe `openvpn.conf`

Por eso propongo generar daemon2 copiando `openvpn.conf` existente y patchéandolo con `sed`, no invocando `ovpn_genconfig` de nuevo. Evita regenerar accidentalmente la config de daemon1.

### 13.4 GCP firewall rule nueva — requiere `terraform apply`

Antes de subir daemon2, la regla `vpn-prod-fw-openvpn-modern` debe estar aplicada. Sino WILO no puede ni llegar al puerto 1195. `terraform apply` es seguro — solo agrega, no modifica existentes.

### 13.5 Admin panel corre como UID 1000 (appuser)

Los directorios `/mnt/vpn-data/ccd-modern` y `/mnt/vpn-data/clients` deben tener ownership `1000:1000`. `startup.sh` ya lo hace para `/ccd` y `/clients`; hay que agregar `/ccd-modern`.

### 13.6 Bug en `startup.sh` regenerando daemon2 config en redeploy

Si el flag `$DAEMON2_CONF ya existe` no funciona bien, un redeploy podría regenerar el config y perder customizaciones. Proteger con flag explícito y testear en staging (o branch de Terraform separado).

---

## 14. Estimación total

| Fase | Esfuerzo | Downtime |
|---|---|---|
| Fase 1 — Infra | 4-6 h | ~3-5min (restart docker + iptables) |
| Fase 2 — Admin panel | 6-8 h | ~1min (rebuild admin container) |
| Fase 3 — Migración WILO | 30min | WILO ya está roto — sin downtime adicional |
| **Total** | **10-14 h** | **~5 min total** |

---

## 15. Criterios de done

- [ ] Fase 1 — ambos daemons up, WILO pingea vía daemon2, UG67 sin afectar.
- [ ] Fase 2 — admin UI alta UG63v2 rutea a daemon moderno automáticamente.
- [ ] Fase 3 — WILO migrado, UI UG63 accesible desde admin desktop sostenidamente.
- [ ] `docker-compose.yml`, `infra/scripts/startup.sh`, `infra/firewall.tf`, `admin/app.py`, templates, JS, CSS commiteados en `master`.
- [ ] `docs/plan_2_daemons_ug63.md` actualizado con notas reales de deploy (qué se cambió vs. plan original).
- [ ] Memoria proyecto (`project_vpn_state.md`) actualizada: "2 daemons (classic 1194/10.8, modern 1195/10.9), PKI compartida, iptables custom chain".

---

## 16. Referencias

- `docs/fix_comp_lzo_ug63.md` — intento fallido de remover comp-lzo global.
- `docs/ssh_acceso_vm.md` — comandos operativos de la VM.
- `logs-errores/milesight support/Second response.docx` — respuesta Milesight confirmando causa y recomendando 2 configs.
- `logs-errores/milesight support/our_server.conf`, `our_client.ovpn` — artefactos enviados al soporte.
- Kylemanna/openvpn repo — `ovpn_genconfig`, `ovpn_run`, estructura del image.
- OpenVPN 2.5 changelog — remoción de `comp-lzo`.
