# Infraestructura OpenVPN WeDo

> Documento de contexto completo — última actualización: 2 de Marzo de 2026

---

## 1. Objetivo General

Desplegar un servidor OpenVPN en una VM con panel de administración web para gestionar clientes VPN. Los clientes principales son:

- **Gateways LoRaWAN (GWs)**: se conectan desde ubicaciones remotas por la IP pública.
- **Administradores**: se conectan desde la red local (LAN) para gestión y monitoreo.

---

## 2. Arquitectura

```
┌─────────────────────────────────────────────────────────┐
│             VM: 172.28.20.206 (LAN)                     │
│             IP Pública: 181.228.71.16                   │
│                                                         │
│   ┌─────────────────┐    ┌──────────────────────────┐   │
│   │   openvpn        │    │   openvpn-admin           │   │
│   │   (kylemanna/    │    │   (Python Flask)          │   │
│   │    openvpn)      │    │                           │   │
│   │                  │    │   Puerto: 8888 → 8080     │   │
│   │   Puerto:        │    │   Monta: docker.sock      │   │
│   │   1194/UDP       │    │   Monta: ./clients        │   │
│   │                  │    │   Monta: ./ccd             │   │
│   │   Volumen:       │    │                           │   │
│   │   openvpn_data   │    │   Docker CLI 27.5.1       │   │
│   │   Monta: ./ccd   │    │   (dentro del container)  │   │
│   └─────────────────┘    └──────────────────────────┘   │
│                                                         │
│   Volúmenes:                                            │
│   - openvpn_openvpn_data (PKI, certs, config)          │
│   - ./ccd (Client Config Dir, compartido)              │
│   - ./clients (archivos .ovpn y clients.json)          │
└─────────────────────────────────────────────────────────┘
```

### Esquema de Red VPN

- **Subred**: `10.8.0.0/16` (65,536 IPs)
- **Admin** (Grupo 0): `10.8.0.x` (254 clientes)
- **Grupo N**: `10.8.N.x` (254 clientes por grupo, N = 1-255)
- **Aislamiento**: iptables bloquea tráfico entre grupos distintos; admin puede ver todo.

---

## 3. Estructura del Proyecto

```
openvpn_wedo/
├── admin/
│   ├── Dockerfile          # Python 3.11-slim + Docker CLI 27.5.1
│   ├── app.py              # Flask app (panel de administración)
│   ├── templates/
│   │   ├── index.html      # Dashboard principal
│   │   └── login.html      # Página de login
│   └── static/
│       ├── css/style.css   # Estilo con sistema de temas light/dark
│       └── js/app.js       # Frontend JS con toggleTheme()
├── ccd/                    # Client Config Dir (IPs fijas por cliente)
├── clients/
│   └── clients.json        # Base de datos de grupos y clientes
├── docker-compose.yml      # Orquestación de servicios
├── .env                    # Variables de entorno (ADMIN_PASSWORD, etc.)
├── setup.sh                # Script de inicialización del servidor
├── enable-ccd.sh           # Script para habilitar CCD exclusivo
├── create-client.sh        # Script CLI para crear clientes
├── revoke-client.sh        # Script CLI para revocar clientes
├── install-docker.sh       # Script para instalar Docker en la VM
└── GUIA_USUARIO.md         # Guía de uso para el usuario final
```

---

## 4. Componentes Clave

### 4.1 Docker Compose (`docker-compose.yml`)

- **openvpn**: Imagen `kylemanna/openvpn`, puerto `1194/UDP`, con reglas iptables para aislamiento entre grupos.
- **openvpn-admin**: Build desde `./admin`, puerto `8888→8080`, monta el Docker socket para ejecutar comandos Docker desde el panel.
- **Volumen externo**: `openvpn_openvpn_data` (debe existir previamente, creado por `setup.sh`).

### 4.2 Panel Admin (`admin/app.py`)

Funcionalidades:

- **Login**: Password configurable via `ADMIN_PASSWORD` env var (default: `admin123`).
- **Grupos**: CRUD de grupos con IP range automático por grupo.
- **Clientes**: Crear/revocar clientes con certificados OpenVPN.
- **Monitoreo**: Ver clientes conectados y rechazados en tiempo real.
- **Dual Remote**: Todos los `.ovpn` (admins y GWs) incluyen IP local + pública, permitiendo conexión tanto desde LAN como desde redes externas.

Variables de entorno relevantes:

- `ADMIN_PASSWORD` — contraseña del panel (default: `admin123`)
- `SECRET_KEY` — clave de sesión Flask
- `LOCAL_SERVER_IP` — IP local de la VM (default: `172.28.20.206`)

### 4.3 PKI (Public Key Infrastructure)

- **CA**: Creada con `nopass` (sin contraseña) usando Easy-RSA dentro del container `kylemanna/openvpn`.
- **Certificado Servidor**: Emitido para `181.228.71.16` (IP pública).
- **Clientes**: Certificados generados con `nopass` (la CA no requiere password).
- **TLS-Auth**: Clave estática (`ta.key`) para seguridad adicional.
- **Todo almacenado en**: volumen Docker `openvpn_openvpn_data` bajo `/etc/openvpn/pki/`.

### 4.4 CCD (Client Config Dir)

- Modo **exclusivo**: solo clientes con archivo CCD válido pueden conectarse.
- Cada archivo CCD contiene: `ifconfig-push <IP_cliente> <IP_peer>`
- Los archivos **deben tener permisos 644** (world-readable) porque OpenVPN corre como `nobody`.
- El directorio CCD **debe tener permisos 755**.

### 4.5 Base de Datos (`clients/clients.json`)

```json
{
  "groups": {
    "admin": {
      "name": "Administradores",
      "icon": "👑",
      "group_num": 0,
      "next_client": 1,
      "can_see_all": true,
      "is_system": true
    }
  },
  "clients": {},
  "next_group_num": 1
}
```

---

## 5. Proceso de Deploy

### 5.1 Preparación de la VM

```bash
# 1. Instalar Docker
chmod +x install-docker.sh
./install-docker.sh
# Desloguear y volver a loguear para permisos de grupo docker

# 2. Copiar el proyecto
scp -r . edciot@172.28.20.206:~/openvpn_wedo/

# 3. Corregir line endings (archivos copiados desde Windows)
cd ~/openvpn_wedo
sed -i 's/\r$//' *.sh
chmod +x *.sh
```

### 5.2 Inicialización de OpenVPN

```bash
# Crear volumen
docker volume create openvpn_openvpn_data

# Generar config del servidor
docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  ovpn_genconfig -u udp://181.228.71.16

# Inicializar PKI (paso a paso, no interactivo)
docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  easyrsa init-pki

docker run -v openvpn_openvpn_data:/etc/openvpn --rm -e EASYRSA_BATCH=1 \
  kylemanna/openvpn easyrsa build-ca nopass

docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  easyrsa gen-dh  # Tarda unos minutos

docker run -v openvpn_openvpn_data:/etc/openvpn --rm -e EASYRSA_BATCH=1 \
  kylemanna/openvpn easyrsa build-server-full 181.228.71.16 nopass

docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  openvpn --genkey --secret /etc/openvpn/pki/ta.key

# Habilitar CCD exclusivo
./enable-ccd.sh

# Levantar servicios
docker compose up -d
```

### 5.3 Verificación

```bash
docker ps                           # Ambos containers corriendo
docker logs openvpn --tail 20       # "Initialization Sequence Completed"
ls -la ~/openvpn_wedo/ccd/          # Directorio con perms 755
```

---

## 6. Issues Conocidos y Soluciones

### 6.1 Docker API Version Mismatch

- **Problema**: `client version 1.43 is too old. Minimum supported API version is 1.44`
- **Causa**: El `Dockerfile` original instalaba Docker CLI 24.0.7 (API 1.43), pero Docker Engine 29.2.1 requiere mínimo 1.44.
- **Solución**: Se actualizó el Docker CLI a 27.5.1 en el `Dockerfile`.

### 6.2 Permisos CCD

- **Problema**: `Could not access file '/etc/openvpn/ccd/test': Permission denied`
- **Causa**: El container admin crea archivos CCD como `root`, pero OpenVPN corre como `nobody` y no puede leerlos.
- **Solución**: `app.py` ahora hace `os.chmod(ccd_path, 0o644)` y `os.chmod(CCD_DIR, 0o755)` al crear archivos CCD. Si hay archivos existentes con permisos incorrectos, arreglar con: `docker exec openvpn-admin sh -c 'chmod 755 /app/ccd && chmod 644 /app/ccd/*'`

### 6.3 CA Nopass vs Stdin

- **Problema**: Timeout al crear clientes desde el panel.
- **Causa**: La CA fue creada con `nopass`, pero `app.py` usaba `-i` flag y enviaba password por stdin, causando que el proceso se cuelgue.
- **Solución**: Se removió el flag `-i` y el envío de stdin. Se usa `subprocess.run()` sin input.

### 6.4 Conexión desde Red Local

- **Problema**: Clientes no conectan cuando están en la misma red que el servidor.
- **Causa**: El `.ovpn` apuntaba solo a la IP pública (`181.228.71.16`). Desde la red local, el NAT hairpinning no funciona.
- **Solución**: Todos los `.ovpn` (admin y GWs) incluyen dos líneas `remote`: IP local primero, IP pública como fallback. Esto permite que cualquier cliente se conecte tanto desde la LAN como desde internet.

### 6.5 Line Endings Windows

- **Problema**: Scripts `.sh` no ejecutan en Linux (`required file not found`).
- **Causa**: Los archivos copiados desde Windows tienen `\r\n` en vez de `\n`.
- **Solución**: `sed -i 's/\r$//' *.sh` en la VM después de copiar.

### 6.6 SSH Key Auth

- **Problema original**: Se generó key RSA y se instaló en `~/.ssh/authorized_keys` en la VM, pero no funcionaba.
- **Causa raíz**: El home directory `/home/edciot` tenía permisos `777` (world-writable). OpenSSH rechaza la autenticación por clave cuando el home, `~/.ssh` o `authorized_keys` son escribibles por grupo u otros (`StrictModes` habilitado por defecto).
- **Causa secundaria**: La clave `id_openvpn_vm` fue creada con passphrase, lo que requería input interactivo.
- **Solución aplicada** (2 de Marzo de 2026):
  1. Se corrigieron permisos: `chmod 755 /home/edciot` (home), `chmod 700 ~/.ssh`, `chmod 600 ~/.ssh/authorized_keys`.
  2. Se generó nueva clave `id_openvpn_vm_nopass` (ed25519, sin passphrase).
  3. Se actualizó `~/.ssh/config` en Windows para usar la nueva clave con `IdentitiesOnly yes`.
- **Estado**: Funcionando. Conexión con `ssh openvpn-vm` sin password.

---

## 7. Credenciales

| Recurso     | Usuario  | Password                |
| ----------- | -------- | ----------------------- |
| VM SSH      | `edciot` | `Edc2820`               |
| Panel Admin | —        | `admin123`              |
| CA OpenVPN  | —        | Sin password (`nopass`) |

---

## 8. URLs

| Servicio                | URL                                |
| ----------------------- | ---------------------------------- |
| Panel Admin (LAN)       | http://172.28.20.206:8888          |
| Panel Admin (local dev) | http://localhost:8888              |
| OpenVPN Server          | `181.228.71.16:1194/UDP` (público) |
| OpenVPN Server          | `172.28.20.206:1194/UDP` (LAN)     |

---

## 9. Operaciones Comunes

### Rebuild del panel admin en la VM

```powershell
# Desde Windows, copiar cambios y rebuild
scp admin\app.py edciot@172.28.20.206:~/openvpn_wedo/admin/app.py
scp admin\Dockerfile edciot@172.28.20.206:~/openvpn_wedo/admin/Dockerfile
ssh edciot@172.28.20.206 "cd ~/openvpn_wedo && docker compose up -d --build openvpn-admin"
```

### Reset completo (borrar todo y empezar de cero)

```bash
# En la VM
cd ~/openvpn_wedo
docker compose down
docker volume rm openvpn_openvpn_data
rm -rf ccd/* && touch ccd/.gitkeep
echo '[]' > admin/clients.json
# Luego seguir los pasos de "Inicialización de OpenVPN" (sección 5.2)
```

### Arreglar permisos CCD

```bash
ssh edciot@172.28.20.206 "docker exec openvpn-admin sh -c 'chmod 755 /app/ccd && chmod 644 /app/ccd/*'"
```

### Ver logs de OpenVPN

```bash
ssh edciot@172.28.20.206 "docker logs openvpn --tail 50"
```

### Ver logs del panel admin

```bash
ssh edciot@172.28.20.206 "docker logs openvpn-admin --tail 50"
```

---

## 10. Tema Light/Dark (UI)

Se implementó un sistema de temas con:

- `style.css`: Variables CSS semánticas en `:root` (dark default) y `[data-theme='light']`.
- `index.html`: Botón toggle `☀️/🌙` en el header.
- `app.js`: Funciones `toggleTheme()` y `updateThemeIcon()` con persistencia en `localStorage`.
- Script anti-FOUC en `<head>` de ambas páginas HTML.

---

## 11. Port Forwarding Pendiente

Para que los GWs se conecten desde internet, se necesita configurar en el router:

- **Puerto**: `UDP 1194`
- **Destino**: `172.28.20.206:1194`

---

## 12. Reset Completo (2 de Marzo de 2026)

Se realizó un reset total del sistema:

1. **Servicios detenidos**: `docker compose down`
2. **Volumen PKI eliminado**: `docker volume rm openvpn_openvpn_data`
3. **CCD y clients limpiados**: eliminados todos los archivos de certificados y configuraciones de clientes.
4. **PKI regenerada desde cero**: nueva CA (nopass), nuevo DH, nuevo cert servidor para `181.228.71.16`, nueva ta.key.
5. **Config OpenVPN actualizada**: subred `10.8.0.0/16`, `topology subnet`, `ccd-exclusive`.
6. **Dual Remote para todos**: se modificó `app.py` para que **todos** los clientes (admin y GWs) reciban `.ovpn` con ambas IPs (local `172.28.20.206` + pública `181.228.71.16`), permitiendo conexión desde LAN y desde redes externas.
7. **Servicios rebuildeados**: `docker compose up -d --build`
8. **Estado**: ambos containers corriendo, `Initialization Sequence Completed`.
