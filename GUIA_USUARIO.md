# 📖 Guía de Usuario - OpenVPN Admin Panel

Esta guía explica cómo utilizar el panel de administración de OpenVPN para gestionar clientes y grupos.

---

## 📑 Índice

1. [Acceso al Panel](#acceso-al-panel)
2. [Interfaz Principal](#interfaz-principal)
3. [Gestión de Grupos](#gestión-de-grupos)
4. [Gestión de Clientes](#gestión-de-clientes)
5. [Monitoreo](#monitoreo)
6. [Preguntas Frecuentes](#preguntas-frecuentes)

---

## 🔐 Acceso al Panel

### Ingresar al sistema

1. Abrir el navegador y acceder a: `http://IP_DEL_SERVIDOR:8888`
2. Ingresar la contraseña de administrador
3. Hacer clic en **Ingresar**

![Login](https://via.placeholder.com/400x200/1a1a2e/00d4ff?text=Login+Screen)

### Cerrar sesión

Hacer clic en el botón **🚪 Cerrar sesión** en la esquina superior derecha.

---

## 🖥️ Interfaz Principal

La interfaz está dividida en varias secciones colapsables:

### Secciones principales

| Sección | Descripción |
|---------|-------------|
| 📡 **Clientes Conectados** | Muestra clientes actualmente conectados a la VPN |
| 🚫 **Clientes Rechazados** | Muestra intentos de conexión bloqueados |
| 📁 **Grupos** | Lista de grupos disponibles con capacidad |
| ➕ **Crear Cliente** | Formulario para crear nuevos clientes |
| ⚠️ **Revocar Cliente** | Formulario para revocar certificados |
| 📋 **Clientes por Grupo** | Vista expandible de todos los clientes organizados por grupo |

### Expandir/Contraer secciones

- Hacer clic en el encabezado de cualquier sección para expandirla o contraerla
- El estado se guarda automáticamente (persiste al recargar la página)
- Los grupos individuales también son expandibles

---

## 📁 Gestión de Grupos

### ¿Qué es un grupo?

Un grupo es un conjunto de clientes VPN que pueden comunicarse entre sí. Los clientes de **diferentes grupos NO pueden verse**.

**Excepciones:**
- El grupo **Administradores** puede ver y comunicarse con TODOS los clientes

### Crear un nuevo grupo

1. Hacer clic en **+ Nuevo Grupo** en la sección Grupos
2. Completar el formulario:
   - **Nombre del grupo**: Ej. "Oficina Buenos Aires", "Cliente ABC"
   - **Icono**: Seleccionar un icono representativo
3. Hacer clic en **Crear Grupo**

El sistema asignará automáticamente un rango de 254 IPs al nuevo grupo.

### Editar un grupo

1. En la lista de grupos, hacer clic en el botón ✏️ (editar)
2. Modificar el nombre y/o icono
3. Hacer clic en **Guardar Cambios**

**Nota:** El grupo "Administradores" no puede editarse.

### Capacidad de grupos

- Cada grupo tiene capacidad para **254 clientes**
- El sistema soporta hasta **255 grupos**
- Capacidad total: **64.770 clientes**

---

## 👥 Gestión de Clientes

### Crear un nuevo cliente

1. Ir a la sección **➕ Crear Cliente**
2. Completar el formulario:
   - **Nombre**: Identificador único (ej: `gw-oficina`, `tecnico-juan`)
     - Solo letras, números, guiones y guiones bajos
     - Sin espacios
   - **Grupo**: Seleccionar el grupo al que pertenecerá
   - **Contraseña de la CA**: Cualquier valor (la CA no tiene contraseña — campo requerido por el formulario pero no se usa)
3. Hacer clic en **Crear Cliente**
4. Esperar a que se genere (puede tardar unos segundos)
5. Descargar el archivo `.ovpn` haciendo clic en **📥 Descargar .ovpn**

### Descargar archivo .ovpn de cliente existente

1. Ir a la sección **📋 Clientes por Grupo**
2. Expandir el grupo del cliente
3. Hacer clic en **📥 .ovpn** junto al nombre del cliente

### Revocar un cliente

⚠️ **ADVERTENCIA:** Esta acción es **IRREVERSIBLE**. El cliente no podrá volver a conectarse.

1. Ir a la sección **⚠️ Revocar Cliente**
2. Ingresar el **nombre exacto** del cliente
3. Ingresar la **contraseña de la CA**
4. Hacer clic en **Revocar**
5. Confirmar la acción en el diálogo

**Nota:** OpenVPN se reiniciará automáticamente para aplicar los cambios. Las conexiones activas se desconectarán momentáneamente.

### Convenciones de nombres sugeridas

| Tipo de cliente | Formato sugerido | Ejemplo |
|-----------------|------------------|---------|
| Gateway/Router | `gw-ubicacion` | `gw-oficina-norte` |
| Usuario | `user-nombre` | `user-juan-perez` |
| Dispositivo | `dev-tipo-id` | `dev-sensor-001` |
| Técnico | `tec-nombre` | `tec-carlos` |

---

## 📊 Monitoreo

### Clientes Conectados

Muestra en tiempo real:
- **Cliente**: Nombre del cliente
- **Grupo**: Grupo al que pertenece (con icono)
- **IP VPN**: Dirección IP asignada en la VPN (clickeable)
- **IP Real**: Dirección IP pública del cliente
- **Conectado**: Fecha y hora de conexión (hora Argentina)
- **Tráfico**: Datos enviados y recibidos

**Actualización automática:** Cada 30 segundos

**Tip:** La IP VPN permite identificar al cliente en la red privada para acceder a sus interfaces web o servicios internos.

### Clientes Rechazados

Muestra clientes que intentaron conectarse pero fueron bloqueados:
- **Cliente**: Nombre del cliente rechazado
- **IP Real**: Desde dónde intentó conectarse
- **Último Intento**: Cuándo fue el último intento
- **Motivo**: Por qué fue rechazado (generalmente "Sin archivo CCD")

**¿Por qué aparece un cliente aquí?**
- El certificado fue revocado
- El cliente fue creado incorrectamente
- Alguien está intentando conectarse con credenciales inválidas

### Estados de clientes

En la sección "Clientes por Grupo":

| Badge | Significado |
|-------|-------------|
| 🟢 **Online** | Cliente conectado actualmente |
| ⚪ **Offline** | Cliente no conectado |

---

## ❓ Preguntas Frecuentes

### ¿Cómo sé qué contraseña de CA usar?

Es la contraseña que creaste durante la instalación inicial (`./setup.sh`). Si la perdiste, necesitarás reinicializar todo el sistema.

### ¿Puedo mover un cliente a otro grupo?

No directamente. Debes:
1. Revocar el cliente actual
2. Crear uno nuevo en el grupo deseado
3. Distribuir el nuevo archivo .ovpn

### ¿Qué pasa si un grupo se llena?

No podrás crear más clientes en ese grupo. Opciones:
- Crear un nuevo grupo
- Revocar clientes que ya no uses

### ¿Por qué un cliente aparece como "Dinámica" en IP VPN?

Esto puede pasar si:
- El cliente acaba de conectarse y aún no se actualizó la tabla
- Hay un problema con el archivo CCD

Haz clic en 🔄 para actualizar.

### ¿Cómo accedo a un dispositivo conectado a la VPN?

1. Busca el cliente en "Clientes Conectados"
2. Haz clic en su IP VPN (ej: `10.8.0.16`)
3. Se abrirá una nueva pestaña con esa IP

### ¿Por qué se desconectan los clientes al revocar uno?

Al revocar un certificado, OpenVPN necesita reiniciarse para cargar la nueva lista de revocación (CRL). Esto causa una desconexión momentánea de todos los clientes, pero se reconectan automáticamente en segundos.

### ¿Cómo instalo el cliente OpenVPN en un dispositivo?

1. Descargar el archivo `.ovpn` desde el panel
2. En Windows/Mac: Instalar [OpenVPN Connect](https://openvpn.net/client/)
3. En Linux: `sudo apt install openvpn`
4. Importar el archivo `.ovpn`
5. Conectar

### ¿Los cambios en el panel se reflejan inmediatamente?

- Crear cliente: ✅ Inmediato
- Revocar cliente: ✅ Inmediato (con reinicio de OpenVPN)
- Crear grupo: ✅ Inmediato
- Ver conexiones: ✅ Actualización cada 30 segundos

---

## 🆘 Soporte

Si tienes problemas, contacta al administrador del sistema o revisa la documentación técnica en [README.md](README.md).

---

© 2026 WeDo IoT Solutions | Desarrollado por Guillermo Ferrucci
