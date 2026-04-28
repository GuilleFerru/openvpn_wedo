# Plan — `.ovpn` con FQDN en lugar de IP pública hardcodeada

**Estado:** Propuesta — no ejecutar hasta aprobación.
**Fecha plan:** 2026-04-23

---

## 1. Contexto

### 1.1 Problema

Los `.ovpn` generados por el admin panel incluyen la IP pública de la VM directamente:

```
remote 34.44.29.193 1194 udp
```

Si la IP cambia (cambio de región GCP, migración a otro cloud, rotación de IP estática, failover DR), **todos los `.ovpn` en todos los gateways quedan rotos al mismo tiempo**.

Situación chicken-and-egg:
- Para actualizar el `.ovpn` del gateway hay que acceder a su UI.
- La UI solo es accesible vía VPN.
- La VPN no funciona porque el `.ovpn` apunta a una IP muerta.
- → Sin acceso remoto. Requiere visita física / alguien en sitio con acceso LAN al UG.

Hoy tenemos 7+ UGs desplegados. Migrar implicaría viajes presenciales.

### 1.2 Referencia — cómo lo resuelve CloudConnexa

`logs-errores/wilo01_sao_paulo.ovpn`:
```
client
dev tun
remote br-gru.gw.openvpn.com 1194 udp
remote br-gru.gw.openvpn.com 443 tcp
remote-cert-tls server
resolv-retry infinite
...
```

Usa FQDN + `resolv-retry infinite`. En cada reconnect resuelve DNS → si cambia el A record, el cliente migra solo sin tocar el `.ovpn`.

### 1.3 Infra ya preparada

Según memoria `project_vpn_state.md`:
- DNS: `vpn.we-do.io` → `34.44.29.193` (Cloudflare A record)
- Cert LE automatizado por Traefik contra ese FQDN

Sólo falta **usar** el FQDN en los `.ovpn` emitidos.

---

## 2. Objetivo

- Que `.ovpn` emitidos apunten a `vpn.we-do.io` (con `34.44.29.193` como fallback).
- `resolv-retry infinite` para que los gateways reintenten resolución tras cambios de DNS.
- Que en el futuro un cambio de IP de la VM se resuelva con un solo cambio de A record en Cloudflare (TTL 60s) → 100% de los gateways reconectan solos.
- Cero cambios en PKI, cero cambios en server config, cero cambios en gateways **después** de este plan.
- Todos los `.ovpn` existentes regenerados y re-subidos una sola vez a cada gateway (última vez).

---

## 3. Diseño

### 3.1 Template `.ovpn` final

```
client
nobind
dev tun
remote-cert-tls server
resolv-retry infinite

remote vpn.we-do.io 1194 udp
remote 34.44.29.193 1194 udp

<key> ... </key>
<cert> ... </cert>
<ca> ... </ca>
key-direction 1
<tls-auth> ... </tls-auth>
```

Cambios vs. template actual:
1. Agrega `resolv-retry infinite` después de `remote-cert-tls server`.
2. Sustituye la línea `remote <IP> <port> udp` por **dos** líneas: FQDN primero, IP segundo.

### 3.2 Cert server — no cambia

El server cert actual tiene CN=`34.44.29.193`. El cliente usa `remote-cert-tls server`, que **no** valida CN contra el hostname en `remote` — valida solo la extensión "TLS Web Server Authentication" en el EKU. Reconfirmado leyendo RFC y man page de OpenVPN.

Conclusión: no hay que re-emitir server cert.

> **Validación:** antes de mergear, hacer prueba: generar un `.ovpn` nuevo apuntando a `vpn.we-do.io`, conectar un desktop de prueba → debe autenticar OK. Si falla por cert mismatch (improbable), el plan se revisa — en ese caso hay que re-emitir server cert con SAN que incluya ambos (`34.44.29.193` + `vpn.we-do.io`).

### 3.3 TTL DNS

Actual A record TTL: verificar en Cloudflare. Recomiendo **60s** (para migraciones futuras rápidas). Cloudflare proxy "naranja" fuerza TTL a "Automatic" — asegurar "DNS only" (gris) en el A record para `vpn.we-do.io`.

---

## 4. Cambios de código

### 4.1 `admin/config.py`

Agregar env var nueva:

```python
VPN_PUBLIC_HOSTNAME = os.environ.get('VPN_PUBLIC_HOSTNAME')   # ej: vpn.we-do.io
VPN_PUBLIC_IP       = os.environ.get('VPN_PUBLIC_IP')         # ej: 34.44.29.193 (fallback)
```

Mantener `LOCAL_SERVER_IP` (feature independiente, sigue activo para el caso de dual-remote a LAN).

### 4.2 `admin/vpn.py::_export_ovpn_config`

Refactor del bloque post-`ovpn_getclient`:

```python
from config import VPN_PUBLIC_HOSTNAME, VPN_PUBLIC_IP, LOCAL_SERVER_IP

def _export_ovpn_config(name):
    result = subprocess.run(
        ['docker', 'run', '-v', f'{VOLUME_NAME}:/etc/openvpn', '--rm',
         'kylemanna/openvpn', 'ovpn_getclient', name],
        capture_output=True, timeout=30,
    )
    if result.returncode != 0:
        return None
    content = result.stdout.decode()

    # Quitar full-tunnel default (split tunnel policy)
    content = re.sub(r'redirect-gateway.*\n?', '', content)

    # Asegurar resolv-retry infinite (idempotente)
    if 'resolv-retry' not in content:
        content = re.sub(
            r'(remote-cert-tls server\n)',
            r'\1resolv-retry infinite\n',
            content,
            count=1,
        )

    # Reescribir la línea remote para usar FQDN primero + IP fallback
    if VPN_PUBLIC_HOSTNAME and VPN_PUBLIC_IP:
        content = re.sub(
            r'remote (\S+) (\d+) (\S+)',
            (
                f'remote {VPN_PUBLIC_HOSTNAME} \\2 \\3\n'
                f'remote {VPN_PUBLIC_IP} \\2 \\3'
            ),
            content,
            count=1,
        )

    # LOCAL_SERVER_IP: dual-remote para acceso LAN (feature anterior, preservado)
    if LOCAL_SERVER_IP:
        content = re.sub(
            r'remote (\S+) (\d+) (\S+)',
            f'remote {LOCAL_SERVER_IP} \\2 \\3\nremote \\1 \\2 \\3',
            content,
            count=1,
        )

    return content
```

Orden de precedencia en el `.ovpn` resultante:
1. `remote <LOCAL_SERVER_IP> 1194 udp` (si está seteado, p/ acceso LAN)
2. `remote vpn.we-do.io 1194 udp`
3. `remote 34.44.29.193 1194 udp`

Gateway intenta 1, si falla → 2 → 3. En prod normalmente matcheará el 2.

### 4.3 `.env.example`

Agregar documentación:

```
# Hostname público del server VPN. Los .ovpn emitidos apuntan aquí como remote primario.
# Si en el futuro cambia la IP, basta con actualizar el A record DNS; los gateways
# reconectan solos sin necesidad de re-emitir .ovpn.
VPN_PUBLIC_HOSTNAME=vpn.we-do.io

# IP pública de respaldo. Se incluye como segundo remote en los .ovpn para casos
# donde el gateway no tiene DNS configurado o la resolución DNS falla temporalmente.
VPN_PUBLIC_IP=34.44.29.193
```

### 4.4 `docker-compose.yml`

En el service `openvpn-admin`, agregar al `environment:`:

```yaml
- VPN_PUBLIC_HOSTNAME=${VPN_PUBLIC_HOSTNAME}
- VPN_PUBLIC_IP=${VPN_PUBLIC_IP}
```

### 4.5 `infra/scripts/startup.sh`

En el paso `[7/9]` donde se crea `.env`, agregar las dos líneas nuevas:

```bash
cat > .env <<EOF
# Generado por startup.sh — $(date)
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SECRET_KEY=${SECRET_KEY}
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
BACKUP_BUCKET=${BACKUP_BUCKET}

# Remote hostname + IP para los .ovpn (ver docs/plan_dns_remote_ovpn.md)
VPN_PUBLIC_HOSTNAME=${DOMAIN}
VPN_PUBLIC_IP=${PUBLIC_IP}

HTTP_PORT=80
HTTPS_PORT=443
EOF
```

Nota: `DOMAIN` ya está en metadata Terraform y apunta al FQDN usado por Traefik.

### 4.6 Terraform — no cambia

`DOMAIN` (ej. `vpn.we-do.io`) y `PUBLIC_IP` ya se inyectan como metadata desde `terraform.tfvars`. Sin cambios Terraform necesarios.

---

## 5. Regeneración bulk de `.ovpn` existentes

Los clientes ya desplegados tienen `.ovpn` con la IP hardcodeada. Hay que regenerarlos en el servidor y que el usuario los re-suba a cada gateway **una vez**.

### 5.1 Endpoint admin nuevo — `POST /api/clients/regenerate-ovpn`

Protegido por auth admin. Itera sobre todos los clientes del DB, llama a `_export_ovpn_config` para cada uno, sobreescribe el `.ovpn` en disco. Returns JSON con resumen:

```json
{
  "total": 13,
  "regenerated": 13,
  "failed": []
}
```

### 5.2 Alternativa CLI (safer para prod)

Script `admin/regenerate_all_ovpn.py`:

```python
import os
from vpn import _export_ovpn_config
from config import CLIENTS_DIR
from db import load_clients_db

db = load_clients_db()
for name in db.get('clients', {}):
    content = _export_ovpn_config(name)
    if content is None:
        print(f"FAIL: {name}")
        continue
    path = os.path.join(CLIENTS_DIR, f'{name}.ovpn')
    with open(path, 'w') as f:
        f.write(content)
    print(f"OK: {name}")
```

Corre una sola vez tras el deploy, dentro del container admin:

```bash
sudo docker exec openvpn-admin python /app/regenerate_all_ovpn.py
```

**Mi recomendación:** endpoint UI con botón "Regenerar todos los .ovpn" (más visible + auditable desde el panel). Agregar toast con resumen al terminar.

### 5.3 UI — botón regenerar

En `admin/templates/index.html`, sección de clientes (o en settings), botón:

```html
<button id="btn-regenerate-ovpn" class="btn btn-secondary">
  <i data-lucide="refresh-cw"></i>
  Regenerar todos los .ovpn
</button>
```

JS: llama `POST /api/clients/regenerate-ovpn`, muestra spinner, luego toast con `regenerated / total`. Si alguno falló, mostrar lista.

### 5.4 Log de regeneración

Server-side: log a `openvpn_admin.vpn.regenerate` con `name`, `status`, timestamp. Útil si alguno falla y hay que repetir.

---

## 6. Flujo de migración (cambio de IP futuro)

Escenario ejemplo: VM se muere, DR en otra región con IP nueva.

1. Levantar nueva VM (Terraform apply en otra región).
2. Restaurar backup PKI + clients DB desde GCS bucket.
3. Actualizar A record Cloudflare: `vpn.we-do.io` → nueva IP. **Con TTL 60s**, propagación global ≤ 2min.
4. Esperar 2-5 min. Los gateways detectan link down por `ping-restart`, reintentan, `resolv-retry infinite` resuelve DNS, obtienen nueva IP, reconectan.
5. Actualizar `.env` en nueva VM: `VPN_PUBLIC_IP=<nueva-IP>`.
6. Correr "Regenerar todos los .ovpn" desde admin UI (no es urgente — los gateways ya están conectados por FQDN; esto es solo para que nuevos downloads reflejen la IP de fallback correcta).

**Cero visitas presenciales.** Cero acceso físico a gateways.

---

## 7. Testing

### 7.1 Test local/staging (antes de mergear)

1. Dev local con `.env` con `VPN_PUBLIC_HOSTNAME=localhost` y `VPN_PUBLIC_IP=127.0.0.1`.
2. Crear cliente test → descargar `.ovpn` → verificar contenido:
   ```
   remote-cert-tls server
   resolv-retry infinite

   remote localhost 1194 udp
   remote 127.0.0.1 1194 udp
   ```

### 7.2 Test en prod post-deploy

1. Deploy a VM.
2. Crear cliente test (`TEST-DNS-01`) → descargar `.ovpn` → validar contenido correcto.
3. Importar `.ovpn` en OpenVPN Connect desktop → conectar → verificar handshake OK.
4. Revocar cliente test.

### 7.3 Test DNS failover (simulación)

Sin tocar prod:
1. Sacar `.ovpn` de un gateway, editar temporalmente: cambiar la IP de fallback a `0.0.0.0` (inválida).
2. Subir al gateway, verificar que igual conecta por FQDN.
3. Restaurar.

(Opcional — prueba que `resolv-retry` + hostname están funcionando de verdad y no es la IP fallback quien salva.)

### 7.4 Test regeneración bulk

1. Contar `.ovpn` en `/mnt/vpn-data/clients/*.ovpn`.
2. `md5sum` de todos antes.
3. Ejecutar "Regenerar todos los .ovpn".
4. `md5sum` de todos después — deben haber cambiado todos.
5. Verificar que cada uno tiene las 2 líneas remote correctas (`grep -c '^remote' *.ovpn` debe dar 2 en cada uno).

---

## 8. Rollback

### 8.1 Rollback código

```bash
git revert <commits>
docker compose build openvpn-admin
docker compose up -d openvpn-admin
```

Regresa al generador viejo (IP única). Los `.ovpn` ya regenerados siguen funcionando igual — las líneas extras (`resolv-retry`, FQDN) son compatibles con servers que aceptan el tráfico entrante. **No hay incompatibilidad** en los gateways aún con el generador revertido.

### 8.2 Rollback `.ovpn` ya subidos a gateways

**No hay que hacer nada.** Los `.ovpn` con FQDN siguen funcionando mientras el DNS apunte a la VM. No hay que tocar los gateways.

### 8.3 Punto de no-retorno

Solo si el FQDN se da de baja en DNS **y** no hay fallback IP válida los gateways quedan sin acceso. Mitigación: el `.ovpn` lleva IP fallback, y además si algo falla se puede re-agregar el A record en Cloudflare en segundos.

---

## 9. Tareas detalladas (checklist)

### 9.1 Código (≈ 2h)

- [ ] `admin/config.py`: añadir `VPN_PUBLIC_HOSTNAME`, `VPN_PUBLIC_IP`.
- [ ] `admin/vpn.py::_export_ovpn_config`: agregar regex `resolv-retry` + reescritura remote.
- [ ] `admin/blueprints/clients.py`: nuevo endpoint `POST /api/clients/regenerate-ovpn`.
- [ ] `admin/static/js/app.js`: botón regenerar + handler + toast.
- [ ] `admin/templates/index.html`: botón en UI.
- [ ] `docker-compose.yml`: env vars en service `openvpn-admin`.
- [ ] `.env.example`: documentación nuevas vars.
- [ ] `infra/scripts/startup.sh`: escribir nuevas vars en `.env` generado.

### 9.2 Cloudflare DNS (≈ 5min)

- [ ] Bajar TTL del A record `vpn.we-do.io` a 60s.
- [ ] Confirmar que está en modo "DNS only" (gris), no "Proxied" (naranja).

### 9.3 Deploy y validación (≈ 30min)

- [ ] Commit + push branch `feat/ovpn-fqdn`.
- [ ] Merge a master.
- [ ] `terraform apply` (si hay cambios en metadata — probablemente no).
- [ ] SSH a VM → `cd /opt/vpn && git pull && docker compose up -d --build openvpn-admin`.
- [ ] Probar alta de cliente test → descargar `.ovpn` → validar contenido (§7.2).
- [ ] Ejecutar "Regenerar todos los .ovpn" desde UI.
- [ ] Spot check: leer `/mnt/vpn-data/clients/000-1-GW001.ovpn` → debe tener FQDN + IP.

### 9.4 Distribución a gateways (≈ 5min por gateway)

- [ ] Para cada gateway, descargar `.ovpn` regenerado desde admin UI.
- [ ] Subir al gateway (UG67/UG56: Network → VPN → OpenVPN Client → Delete instance + Import + Apply).
- [ ] Verificar en admin UI que sigue listado como conectado (debería ser `~30s downtime` por reconexión).
- [ ] Orden sugerido: **NO** empezar por el gateway del que depende tu acceso (ej: Guille-Admin-PC-Casa primero desde Windows OpenVPN Connect — desktop reconecta solo desde la misma máquina). Luego UG67 uno por uno, dejando WILO para cuando el plan del segundo daemon esté resuelto.

### 9.5 Documentación

- [ ] Actualizar `GUIA_USUARIO.md` con nota: "los `.ovpn` emitidos usan FQDN; un cambio de IP del server no rompe gateways desplegados".
- [ ] Actualizar memoria `project_vpn_state.md` con: "ovpn emite FQDN + IP fallback".

---

## 10. Estimación

| Bloque | Esfuerzo |
|---|---|
| Código + tests | 2 h |
| Cloudflare TTL | 5 min |
| Deploy | 30 min |
| Distribución a gateways (13 clientes) | ~1.5 h total (pero puede escalonar — no tiene deadline estricto) |
| **Total activo** | **~4 h** |

---

## 11. Riesgos

| Riesgo | Severidad | Mitigación |
|---|---|---|
| Server cert no valida con FQDN en cliente | Baja | `remote-cert-tls server` no hace hostname check. Validado por RFC + doc OpenVPN. Test en §7.2 lo confirma antes de bulk rollout. |
| Gateway sin DNS configurado | Media | IP fallback en segundo `remote`. `resolv-retry` no infinitamente bloqueante — intenta los dos en loop. |
| Regenerate bulk corrompe algún `.ovpn` | Baja | Operación idempotente. Log de fallos. `.ovpn` anterior sobrescrito — backup previo antes de correr. |
| DNS caché agresivo en firmware UG | Baja-Media | `resolv-retry infinite` fuerza reresolución en cada reconnect. TTL 60s en Cloudflare. Aceptable si reconexión tarda 1-2 min en caso de cambio. |
| Cloudflare proxy interfiere | Baja | Mantener A record en modo "DNS only" (gris). |

---

## 12. Criterios de done

- [ ] Nuevos `.ovpn` tienen FQDN como primer remote y IP como fallback.
- [ ] `resolv-retry infinite` presente.
- [ ] Regeneración bulk completada sin errores.
- [ ] 100% de gateways actualizados con nuevo `.ovpn` y reconectados OK.
- [ ] Admin UI muestra el botón "Regenerar todos los .ovpn" funcional.
- [ ] Cloudflare TTL = 60s en el A record de `vpn.we-do.io`.
- [ ] Documentación actualizada.
