# OpenVPN Admin Panel

Sistema de administración web para OpenVPN con aislamiento por grupos de clientes.

![OpenVPN Admin](https://img.shields.io/badge/OpenVPN-Admin-00d4ff?style=for-the-badge)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?style=for-the-badge)
![Flask](https://img.shields.io/badge/Flask-Python-green?style=for-the-badge)

## 🌟 Características

- **Panel Web Moderno**: Interfaz responsive con tema oscuro
- **Gestión de Grupos**: Organiza clientes en grupos aislados entre sí
- **Aislamiento de Red**: Clientes de un grupo solo pueden comunicarse entre ellos
- **Grupo Admin**: Los administradores pueden ver y comunicarse con todos
- **IPs Fijas**: Cada cliente recibe una IP fija dentro de su grupo
- **Descarga .ovpn**: Generación y descarga de archivos de configuración
- **Seguridad CCD-Exclusive**: Solo clientes con CCD válido pueden conectarse
- **Monitoreo en Tiempo Real**: Ver clientes conectados y rechazados
- **Persistencia de Estado**: Las preferencias de UI se mantienen entre recargas

## 📋 Requisitos

- Ubuntu/Debian Server (probado en Ubuntu 22.04)
- Docker y Docker Compose
- IP pública fija
- Puerto 1194/UDP abierto en firewall
- Puerto 80/443 TCP para el panel admin (vía Caddy, configurable con HTTP_PORT/HTTPS_PORT)

## 🚀 Instalación

### 1. Clonar el repositorio

```bash
git clone https://github.com/GuilleFerru/openvpn_wedo.git
cd openvpn_wedo
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
nano .env
```

Editar las variables:
```env
ADMIN_PASSWORD=tu_contraseña_segura
SECRET_KEY=clave_secreta_para_flask
```

### 3. Dar permisos a los scripts

```bash
chmod +x *.sh
```

### 4. Inicializar OpenVPN

```bash
./setup.sh <IP_PUBLICA_DEL_SERVIDOR>
```

**Ejemplo:**
```bash
./setup.sh 200.59.147.112
```

Durante la inicialización:
1. Te pedirá crear una **contraseña para la CA** (Autoridad Certificadora)
2. **¡ANOTALA!** La necesitarás para crear cada cliente
3. Te pedirá un "Common Name" - podés dejarlo por defecto

### 5. Habilitar CCD Exclusivo (Seguridad)

```bash
./enable-ccd.sh
```

Esto activa:
- Solo clientes con archivo CCD pueden conectarse
- Clientes revocados son bloqueados automáticamente

### 6. Iniciar los servicios

```bash
docker compose up -d
```

### 7. Acceder al panel

Abrir en el navegador: `http://IP_DEL_SERVIDOR:8888`

Ingresar con la contraseña configurada en `.env`

## 🏗️ Arquitectura de Red (Actualizada a /16)

Debido a limitaciones técnicas de OpenVPN con subredes masivas, se implementó una **Subred /16** que garantiza máxima estabilidad.

```
Subred: 10.8.0.0/16 (10.8.0.0 - 10.8.255.255)

├── Admin (10.8.0.1 - 10.8.0.254)       → Grupo 0 (Admin)
├── Grupo 1 (10.8.1.1 - 10.8.1.254)     → Grupo 1
├── Grupo 2 (10.8.2.1 - 10.8.2.254)     → Grupo 2
│   ...
└── Grupo 255 (10.8.255.1 - 10.8.255.254) → Grupo 255
```

**Capacidad:**
- **~65,536** IPs totales.
- **255** Grupos disponibles.
- **254** Clientes por grupo.

**Lógica de IPs:**
- La estructura es: `10.8.[GRUPO].[CLIENTE]`
- **Tercer octeto**: Indica el número de grupo (0-255).
- **Cuarto octeto**: Indica el cliente (1-254).

**Reglas de comunicación:**
- ✅ Clientes del mismo grupo pueden verse entre sí.
- ✅ Admin (Grupo 0) puede ver a todos los clientes.
- ❌ Clientes de diferentes grupos NO pueden verse.

## 📁 Estructura del Proyecto

```
openvpn_vdd/
├── admin/
│   ├── app.py              # API Flask
│   ├── Dockerfile
│   ├── static/
│   │   ├── css/style.css   # Estilos
│   │   └── js/app.js       # JavaScript
│   └── templates/
│       ├── index.html      # Panel principal
│       └── login.html      # Página de login
├── ccd/                    # Client Config Directory
├── docker-compose.yml      # Orquestación Docker
├── setup.sh                # Instalación inicial
├── enable-ccd.sh           # Habilitar seguridad CCD
├── create-client.sh        # Crear cliente (CLI)
├── revoke-client.sh        # Revocar cliente (CLI)
├── list-clients.sh         # Listar clientes (CLI)
├── .env.example            # Variables de ejemplo
└── README.md
```

## 🔧 Comandos Útiles

### Ver logs de OpenVPN
```bash
docker logs openvpn -f
```

### Ver logs del panel admin
```bash
docker logs openvpn-admin -f
```

### Reiniciar servicios
```bash
docker compose restart
```

### Reconstruir después de cambios
```bash
docker compose up -d --build
```

### Ver clientes conectados (CLI)
```bash
docker exec openvpn cat /tmp/openvpn-status.log
```

## 🔒 Seguridad

- **CCD-Exclusive**: Solo clientes con archivo CCD pueden conectarse
- **Certificados Revocados**: Se bloquean automáticamente
- **Aislamiento iptables**: Grupos separados a nivel de red
- **Contraseña CA**: Requerida para crear/revocar clientes
- **Sesión Flask**: Cookies seguras con secret key

## 🐛 Solución de Problemas

### El panel no carga
```bash
docker compose logs openvpn-admin
```

### Clientes no pueden conectarse
1. Verificar que el puerto 1194/UDP esté abierto
2. Verificar que el cliente tenga archivo CCD:
   ```bash
   ls -la ccd/
   ```
3. Ver logs de OpenVPN:
   ```bash
   docker logs openvpn --tail 50
   ```

### Error "ifconfig-pool conflict"
```bash
docker compose down
docker run -v openvpn_openvpn_data:/etc/openvpn --rm kylemanna/openvpn \
  sh -c 'sed -i "/^ifconfig-pool/d" /etc/openvpn/openvpn.conf'
docker compose up -d
```

## 📖 Documentación

Ver [GUIA_USUARIO.md](GUIA_USUARIO.md) para instrucciones detalladas de uso del panel.

## 📝 Licencia

MIT License

## 👨‍💻 Autor

**Guillermo Ferrucci**  
WeDo IoT Solutions

---

© 2026 WeDo IoT Solutions
