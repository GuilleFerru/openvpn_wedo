# Guia de Usuario - WeDo VPN Admin

Panel de administracion para gestionar clientes y grupos OpenVPN.

---

## Acceso al Panel

1. Abrir el navegador: `https://vpn.we-do.io`
2. Ingresar la contrasena de administrador
3. Click en **Ingresar**

Para cerrar sesion: click en **Cerrar sesion** en la esquina superior derecha.

---

## Interfaz Principal

La interfaz tiene dos columnas:

**Columna izquierda (datos):**
- Conexiones activas
- Clientes rechazados (visible solo si hay)
- Clientes por grupo

**Columna derecha (acciones):**
- Grupos
- Nuevo cliente
- Revocar cliente

**Stats row** (arriba): conectados, clientes totales, grupos activos.

Todas las secciones son colapsables (click en el header). El estado se guarda automaticamente.

---

## Gestion de Grupos

### Que es un grupo

Un grupo es un conjunto de clientes VPN que pueden comunicarse entre si. Clientes de **diferentes grupos NO pueden verse**.

El grupo **Administradores** es especial: puede ver y acceder a TODOS los clientes de todos los grupos.

### Crear un grupo

1. Click en **+ Nuevo** en la seccion Grupos
2. Completar:
   - **Nombre del grupo**: ej. "Schroeder", "WeDo"
   - **Iniciales**: 1-2 letras para el monograma (ej. "SC", "WD")
3. Click en **Crear Grupo**

El sistema asigna automaticamente un rango de 254 IPs al grupo.

### Editar un grupo

1. Click en el icono de lapiz junto al grupo
2. Modificar nombre y/o iniciales
3. Click en **Guardar Cambios**

El grupo Administradores no puede editarse.

### Capacidad

- Cada grupo: **254 clientes**
- Maximo: **255 grupos**
- Total: **~65,000 clientes**

---

## Gestion de Clientes

### Crear un cliente

1. Ir a **Nuevo Cliente**
2. Completar:
   - **Nombre**: identificador unico (ej: `000-1-GW001`, `Guille-Admin`)
     - Solo letras, numeros, guiones y guiones bajos
     - Sin espacios
   - **Grupo**: seleccionar grupo
3. Click en **Crear Cliente**
4. Esperar generacion (puede tardar unos segundos)
5. Descargar el archivo `.ovpn` desde el link que aparece

El certificado del cliente dura **10 anios**.

### Descargar .ovpn de cliente existente

1. Ir a **Clientes por grupo**
2. Expandir el grupo
3. Click en **.ovpn** junto al cliente

### Revocar un cliente

**ADVERTENCIA: Accion IRREVERSIBLE.** El cliente no podra volver a conectarse. La IP queda reservada (no se reasigna).

1. Ir a **Revocar Cliente**
2. Ingresar el nombre exacto del cliente
3. Click en **Revocar**
4. Confirmar en el dialogo

OpenVPN se reinicia automaticamente. Las conexiones activas se desconectan momentaneamente y reconectan solas.

### Convenciones de nombres sugeridas

| Tipo | Formato | Ejemplo |
|------|---------|---------|
| Gateway | `NNN-G-GWXXX` | `000-1-GW001` (cliente 1, grupo WeDo) |
| Admin PC | `Nombre-Admin` | `Guille-Admin` |
| Admin casa | `Nombre-Admin-PC-Casa` | `Guille-Admin-PC-Casa` |

---

## Monitoreo

### Conexiones activas

Muestra en tiempo real (auto-refresh cada 30s):

| Columna | Descripcion |
|---------|-------------|
| Cliente | Nombre del cliente |
| Grupo | Grupo con monograma |
| IP VPN | Direccion IP en la VPN (clickeable, abre en nueva ventana) |
| IP Real | Direccion IP publica del cliente |
| Conectado | Fecha y hora de conexion (hora Argentina) |
| Trafico | Datos enviados/recibidos |

### Clientes rechazados

Aparece solo si hay intentos bloqueados. Motivos posibles:
- Certificado revocado
- Sin archivo CCD valido
- Credenciales invalidas

### Estados

| Badge | Significado |
|-------|-------------|
| **Online** (verde) | Conectado |
| **Offline** (gris) | No conectado |

---

## Aislamiento de Red

| Desde / Hacia | Mismo grupo | Otro grupo | Admin |
|---------------|-------------|------------|-------|
| Cliente normal | SI | NO | NO |
| Admin | SI | SI | SI |

- Admin ve todo. Los demas solo ven su grupo.
- El bloqueo es a nivel de iptables: todo protocolo (ping, SSH, HTTP, etc.).

---

## Como conectar un dispositivo

### PC (Windows/Mac)

1. Descargar `.ovpn` desde el panel
2. Instalar [OpenVPN Connect](https://openvpn.net/client/)
3. Importar el archivo `.ovpn`
4. Conectar

### Linux

```bash
sudo apt install openvpn
sudo openvpn --config archivo.ovpn
```

### Gateway Milesight

1. Descargar `.ovpn` desde el panel
2. En la interfaz web del gateway: Network > VPN > OpenVPN
3. Subir el archivo `.ovpn` como configuracion
4. Activar la conexion

### Notas

- La VPN usa **split tunnel**: solo trafico hacia 10.8.x.x va por el VPN. Internet no se ve afectado.
- Los `.ovpn` incluyen IP local y publica del servidor como dual-remote (si `LOCAL_SERVER_IP` esta configurado).
- Los certificados duran 10 anios. No hay que renovarlos a corto plazo.

---

## Preguntas Frecuentes

### Puedo mover un cliente a otro grupo?

No directamente. Hay que revocar el cliente y crear uno nuevo en el grupo deseado.

### Que pasa si un grupo se llena?

No se pueden crear mas clientes en ese grupo. Crear un nuevo grupo o revocar clientes que no se usen.

### Por que aparece "Dinamica" en IP VPN?

El cliente recien se conecto y la tabla aun no se actualizo. Click en el boton de refresh.

### Por que se desconectan todos al revocar uno?

OpenVPN se reinicia para cargar la nueva lista de revocacion (CRL). Los clientes reconectan automaticamente en segundos.

### Como accedo a un gateway conectado?

1. Buscar el cliente en Conexiones activas
2. Click en su IP VPN (ej: `10.8.1.1`)
3. Se abre en nueva ventana — acceder via SSH o interfaz web del gateway

---

WeDo IoT Solutions | Desarrollado por Guillermo Ferrucci
