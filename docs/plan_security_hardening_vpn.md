# Plan Hardening Seguridad — vpn-prod-vm

> **Para ejecutar**: ir tarea por tarea. Cada tarea tiene **verificación** que confirma servicio sigue funcionando antes de pasar a la siguiente. Marca el checkbox al cerrar.

**Goal:** Cerrar hallazgos SCC y refuerzos extra sobre `vpn-prod-vm` sin downtime de clientes VPN ni del panel admin.

**Architecture:** Cambios aplican vía Terraform (`infra/`) primero — único source of truth. Cambios runtime (Secret Manager bootstrap, OpenVPN config) se documentan tras aplicar. Cada tarea es reversible y verificable de manera independiente.

**Tech Stack:** Terraform 5.45.2 (provider google), gcloud CLI, Docker Compose, OpenVPN, Secret Manager.

**Project:** `integracion-tagoio` · **VM:** `vpn-prod-vm` · **Zone:** `us-central1-a` · **Public IP:** `34.44.29.193` · **Domain:** `vpn.we-do.io`

---

## Pre-flight (hacer una sola vez antes de Task 1)

- [ ] **PF1: Confirmar IAP SSH funciona**

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap --command="echo ok"
```
Esperado: `ok`. Si falla, **STOP** — resolver IAP antes de seguir (Task 4 lo asume).

- [ ] **PF2: Snapshot baseline funcionalidad**

```bash
# Panel responde
curl -sI https://vpn.we-do.io/ | head -1
# OpenVPN responde (paquete UDP — esperar timeout silencioso si tls-crypt activo)
nc -uvz 34.44.29.193 1194
nc -uvz 34.44.29.193 1195
# Conteo clientes conectados
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="docker exec openvpn cat /tmp/openvpn-status.log 2>/dev/null | grep -c 'CLIENT_LIST,' || true"
```
Anotar conteos en una nota. Verificación post-tarea compara contra esto.

- [ ] **PF3: Backup tfstate + tfvars**

```bash
cp infra/.terraform/terraform.tfstate infra/.terraform/terraform.tfstate.bak-$(date +%Y%m%d)
cp infra/terraform.tfvars infra/terraform.tfvars.bak-$(date +%Y%m%d)
```

- [ ] **PF4: Verificar `terraform plan` está limpio antes de empezar**

```bash
cd infra
terraform plan
```
Esperado: `No changes`. Si muestra drift, resolver antes de empezar — el plan asume baseline limpia.

---

## Task 1 — Restringir firewall HTTPS panel admin (P0) — ✅ APLICADO 2026-04-28

**Resultado:** `vpn-prod-fw-https` ahora solo acepta `181.228.71.16/32` (IP Guille). Panel responde 302 desde IP autorizada. VPN clientes (11 conectados) sin afectación. Quirk del provider google v5.45.2 obligó a `terraform apply -replace` (in-place update generaba unión de source_ranges en lugar de reemplazo).



**Problema:** `vpn-prod-fw-https` permite 80/443 desde `0.0.0.0/0`. Panel Flask con auth password único es superficie alta.

**Files:**
- Modify: `infra/firewall.tf` (rule `https`, líneas 35-46)
- Modify: `infra/variables.tf` (agregar `var.admin_allowed_cidrs`)
- Modify: `infra/terraform.tfvars` (definir CIDRs)

**Decisión previa:** elegir UNA opción:

| Opción | Pro | Contra |
|---|---|---|
| **A) Source IP whitelist** | Simple, no auth extra, gateway clients no afectados | Necesita IPs fijas; ISP dinámico rompe |
| **B) IAP HTTPS (TCP forwarding)** | Auth Google + 2FA, sin IPs fijas | Cambia URL/flow para admins; setup +complejo |
| **C) Cloudflare/Cloud Armor delante** | Filtro WAF, rate-limit | Más infra; requiere DNS proxy |

> **Default recomendado:** **A** (whitelist) — más simple y los admins son pocos. Si IPs cambian seguido, ir a B después.

### Sub-task 1A — Whitelist source IPs

- [x] **Step 1: Decidir CIDRs admin** (anotar IPs autorizadas)

Ejemplo: oficina `200.X.Y.Z/32`, casa Guille `190.A.B.C/32`. Como mínimo: la IP desde la que se administra hoy.

```bash
# Ver IP pública actual del admin
curl -s ifconfig.me; echo
```

- [x] **Step 2: Agregar variable a `infra/variables.tf`**

```hcl
variable "admin_allowed_cidrs" {
  description = "CIDRs autorizados para acceder al panel admin HTTPS (80/443)."
  type        = list(string)
  default     = []
}
```

- [x] **Step 3: Definir valor en `infra/terraform.tfvars`**

```hcl
admin_allowed_cidrs = [
  "200.X.Y.Z/32",   # Oficina We-Do
  "190.A.B.C/32",   # Guille casa
]
```

- [x] **Step 4: Modificar `infra/firewall.tf` rule `https`**

Reemplazar `source_ranges = ["0.0.0.0/0"]` por:
```hcl
  source_ranges = var.admin_allowed_cidrs
```

- [x] **Step 5: Plan + apply**

```bash
cd infra
terraform plan
# ⚠️ Si plan muestra que source_ranges agrega el nuevo CIDR sin sacar el viejo
# (provider quirk con TypeSet), forzar replace:
terraform apply -replace=google_compute_firewall.https
# Si plan muestra reemplazo limpio:
terraform apply
```

- [x] **Step 6: Verificación funcional**

```bash
# Desde IP autorizada — debe responder
curl -sI https://vpn.we-do.io/ | head -1
# Esperado: HTTP/2 302 o 200

# Desde IP NO autorizada (móvil con datos, otra red) — debe colgar/timeout
# Probar manual.
```

- [x] **Step 7: Confirmar OpenVPN sigue conectando** (panel restringido no afecta UDP 1194/1195)

```bash
# Conteo clientes — debe igualar baseline PF2
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="docker exec openvpn cat /tmp/openvpn-status.log 2>/dev/null | grep -c 'CLIENT_LIST,'"
```

- [x] **Step 8: Commit**

Commit `3f22d13`: `security(fw): restrict admin HTTPS panel to whitelisted CIDRs`. `terraform.tfvars` no commiteado (gitignored, IP residencial).

> **Si elegiste B (IAP HTTPS)** o **C (Cloudflare)** — abrir nuevo plan; queda fuera de este documento.

**Rollback:** revertir `source_ranges` a `["0.0.0.0/0"]`, `terraform apply`.

---

## Task 2 — Migrar secrets (admin-password, secret-key) a Secret Manager (P0) — ✅ APLICADO 2026-05-17

**Resultado:** `vpn-admin-password` y `vpn-secret-key` creados en Secret Manager. SA `vpn-prod-sa` con role `secretmanager.secretAccessor` sobre ambos. `startup.sh` actualizado para leer via `gcloud secrets versions access` y pusheado a metadata VM (gcloud directo — `ignore_changes` impide path TF). Metadata limpia: ya no contiene `admin-password` ni `secret-key`. Panel sigue OK (302), 21 clientes daemon1 activos, sin restart de VM (uptime 33 días intacto). Commit: `f6a02dd`.

**Sync note:** push del nuevo `startup.sh` se hizo via `gcloud compute instances add-metadata --metadata-from-file=startup-script=...` porque `compute.tf` tiene `lifecycle.ignore_changes = [metadata_startup_script]` (cualquier edit por TF dispara ForceNew = VM recreate). El `.env` en disco persistente sigue con los valores actuales, así que el código nuevo solo correrá en próximo bootstrap.



**Problema:** secrets en instance metadata son leídos vía API por cualquier identidad con `compute.instances.get`, y por cualquier proceso dentro de la VM vía `metadata.google.internal`. Filtran en exports/snapshots.

**Files:**
- Create: `infra/secrets.tf`
- Modify: `infra/iam.tf` (agregar binding secretAccessor)
- Modify: `infra/compute.tf` (remover keys de `metadata`)
- Modify: `infra/scripts/startup.sh` (líneas 17-20, 131-145)

- [x] **Step 1: Crear `infra/secrets.tf`**

```hcl
# ============================================================
# Secrets — Secret Manager para admin-password y secret-key
# ============================================================

resource "google_secret_manager_secret" "admin_password" {
  secret_id = "vpn-admin-password"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_password" {
  secret      = google_secret_manager_secret.admin_password.id
  secret_data = var.admin_password
}

resource "google_secret_manager_secret" "secret_key" {
  secret_id = "vpn-secret-key"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "secret_key" {
  secret      = google_secret_manager_secret.secret_key.id
  secret_data = var.secret_key
}
```

- [x] **Step 2: Agregar IAM binding en `infra/iam.tf`**

Agregar al final del archivo:
```hcl
# Secret Manager — leer secrets de admin-password y secret-key
resource "google_secret_manager_secret_iam_member" "vpn_admin_password_access" {
  secret_id = google_secret_manager_secret.admin_password.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vpn_sa.email}"
}

resource "google_secret_manager_secret_iam_member" "vpn_secret_key_access" {
  secret_id = google_secret_manager_secret.secret_key.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vpn_sa.email}"
}
```

- [x] **Step 3: Aplicar primero (sin tocar VM ni startup todavía)**

```bash
cd infra
terraform plan
# Esperado: + 4 resources Secret Manager + 2 IAM bindings
terraform apply
```

- [x] **Step 4: Verificar SA puede leer**

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap --command="
  gcloud secrets versions access latest --secret=vpn-admin-password | wc -c
  gcloud secrets versions access latest --secret=vpn-secret-key | wc -c
"
```
Esperado: `13` (longitud admin-password) y `64` (longitud secret-key) aprox.

- [x] **Step 5: Modificar `infra/scripts/startup.sh` líneas 17-25**

Reemplazar bloque:
```bash
# --- 1. Leer configuración desde metadata + Secret Manager ---
echo "[1/8] Leyendo metadata..."
DOMAIN=$(get_meta domain-name)
ACME_EMAIL=$(get_meta acme-email)
PUBLIC_IP=$(get_meta public-ip)
REPO_URL=$(get_meta repo-url)
BACKUP_BUCKET=$(get_meta backup-bucket)

# Secrets desde Secret Manager (no desde metadata)
ADMIN_PASSWORD=$(gcloud secrets versions access latest --secret=vpn-admin-password)
SECRET_KEY=$(gcloud secrets versions access latest --secret=vpn-secret-key)
```

- [x] **Step 6: Aplicar el cambio en la VM viva (no esperar reboot)**

**Aplicado distinto a lo planeado**: pusheamos `startup.sh` actualizado directo a metadata via `gcloud compute instances add-metadata --metadata-from-file=startup-script=scripts/startup.sh`. Esto es sync local→VM sin pasar por TF (que tiene `ignore_changes` + `ForceNew`). El `.env` activo no se toca; el nuevo código solo aplica en próximo bootstrap.

```bash
cd infra
gcloud compute instances add-metadata vpn-prod-vm --zone=us-central1-a \
  --metadata-from-file=startup-script=scripts/startup.sh
```

- [x] **Step 7: Quitar secrets de metadata en `infra/compute.tf`**

En `metadata = { ... }` (líneas 52-62) borrar:
```hcl
    admin-password     = var.admin_password
    secret-key         = var.secret_key
```

- [x] **Step 8: Plan + apply (cambio de metadata es in-place, sin reboot)**

```bash
cd infra
terraform plan
# Esperado: ~ google_compute_instance.vpn_vm metadata changed (in-place update)
terraform apply
```

- [x] **Step 9: Verificación crítica — `.env` sigue funcionando, panel autentica**

```bash
# Verificar metadata YA NO contiene secrets
gcloud compute instances describe vpn-prod-vm --zone=us-central1-a \
  --format="value(metadata.items[].key)" | tr ';' '\n' | grep -E 'admin-password|secret-key'
# Esperado: SIN salida

# Panel sigue funcionando con la pwd actual
curl -sI https://vpn.we-do.io/ | head -1
# Login manual desde browser → confirmar que admin-password sigue válido
```

- [x] **Step 10: Verificación VPN clientes siguen conectados**

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="docker exec openvpn cat /tmp/openvpn-status.log 2>/dev/null | grep -c 'CLIENT_LIST,'"
# Comparar contra baseline PF2
```

- [x] **Step 11: Commit**

Commit `f6a02dd`: `security(secrets): move admin-password and secret-key to Secret Manager`.

**Rollback:** restaurar líneas 55-56 en `compute.tf`, `terraform apply`. Secrets quedan en Secret Manager (no estorban).

---

## Task 3 — Activar Secure Boot (P2, requiere reboot ~2 min)

**Problema:** `shieldedInstanceConfig.enableSecureBoot=false`.

**Files:**
- Modify: `infra/compute.tf` (agregar bloque `shielded_instance_config`)

- [ ] **Step 1: Agregar bloque a `infra/compute.tf`** (dentro de `google_compute_instance.vpn_vm`, antes de `lifecycle`)

```hcl
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }
```

- [ ] **Step 2: Plan + apply (Terraform detiene VM, actualiza, arranca)**

```bash
cd infra
terraform plan
# Esperado: ~ google_compute_instance.vpn_vm shielded_instance_config (in-place, requires stop)
terraform apply
```

> Downtime esperado: 60-120 seg. Avisar a usuarios VPN si es horario laboral.

- [ ] **Step 3: Esperar VM Running + container up**

```bash
# Wait until status = RUNNING
until [ "$(gcloud compute instances describe vpn-prod-vm --zone=us-central1-a --format='value(status)')" = "RUNNING" ]; do sleep 5; done
# Wait until docker compose up
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap --command="
  cd /opt/openvpn-admin && docker compose ps --format 'table {{.Service}}\t{{.State}}'
"
```
Esperado: `openvpn` y `openvpn-admin` ambos `running`.

- [ ] **Step 4: Verificar Secure Boot activo**

```bash
gcloud compute instances describe vpn-prod-vm --zone=us-central1-a \
  --format="value(shieldedInstanceConfig.enableSecureBoot)"
# Esperado: True
```

- [ ] **Step 5: Verificar panel + VPN clientes**

```bash
curl -sI https://vpn.we-do.io/ | head -1
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="docker exec openvpn cat /tmp/openvpn-status.log 2>/dev/null | grep -c 'CLIENT_LIST,'"
```

- [ ] **Step 6: Commit**

```bash
git add infra/compute.tf
git commit -m "security(vm): enable Secure Boot on vpn-prod-vm"
```

**Rollback:** quitar bloque `shielded_instance_config` (o set `enable_secure_boot=false`), `terraform apply`. Otro reboot.

---

## Task 4 — Verificar `tls-crypt` activo en ambos daemons OpenVPN (P2) — ✅ AUDITADO 2026-04-28

**Resultado:** ambos daemons usan `tls-auth` (no `tls-crypt`). Decisión: **aceptar tls-auth, NO migrar ahora** — breaking change para clientes (regenerar todos los `.ovpn` + reflashear gateways Milesight). Riesgo residual bajo: tls-auth sigue autenticando handshake, único diferencial es que tls-crypt cifra el handshake (oculta versión OpenVPN al scanner). Reabrir migración si hay que tocar PKI por otro motivo.

**Sub-óptimos detectados (no críticos):** sin `tls-version-min` explícito, sin `cipher`/`auth` explícitos. Considerar añadir en pasada futura.

**Problema:** `vpn-prod-fw-vpn(-modern)` aceptan UDP de cualquier IP. Es OK *si y solo si* `tls-crypt` (no `tls-auth`) está activo — descarta paquetes inválidos sin gastar CPU/responder.

**Files:** ninguno (lectura de config dentro del container OpenVPN).

- [x] **Step 1: Inspeccionar config corriendo dentro del container**

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap --command="
  for cfg in /etc/openvpn/openvpn.conf /etc/openvpn/openvpn-modern.conf; do
    echo '=== '\$cfg' ==='
    docker exec openvpn grep -E '^(tls-crypt|tls-auth|key-direction)' \$cfg 2>/dev/null || echo '(no aplicable o no existe)'
  done
"
```

- [x] **Step 2: Interpretar resultado**

| Salida esperada | Acción |
|---|---|
| `tls-crypt /etc/openvpn/pki/ta.key` (en ambos) | ✅ OK, marcar tarea completa |
| `tls-auth ...` (cualquiera) | ⚠️ Migrar a tls-crypt — abrir sub-tarea aparte |
| Sin línea `tls-*` | ❌ CRÍTICO — VPN aceptando paquetes sin auth de capa 2. Investigar urgente |

- [x] **Step 3: Si todo OK, registrar evidencia**

Evidencia (2026-04-28): ambos configs muestran `tls-auth /etc/openvpn/pki/ta.key` + `key-direction 0`. Decisión arriba: aceptar como excepción.

- [x] **Step 4: Commit (sólo si hubo cambio)**

No hubo cambios de config — solo lectura. Sin commit.

> Migración tls-auth → tls-crypt diferida: invalida `.ovpn` de todos los clientes (gateways Milesight remotos). Reabrir como plan separado cuando haya otro motivo para regenerar PKI.

---

## Task 5 — Apagar serial port (P3)

**Problema:** `serial-port-enable=TRUE` permite acceso vía `gcloud compute connect-to-serial-port`. Vector adicional.

**Files:**
- Modify: `infra/compute.tf` (línea 54)

- [ ] **Step 1: Cambiar valor**

En `metadata = { ... }`:
```hcl
    serial-port-enable = "FALSE"
```

- [ ] **Step 2: Apply**

```bash
cd infra
terraform plan
# Esperado: ~ google_compute_instance.vpn_vm metadata change (in-place)
terraform apply
```

- [ ] **Step 3: Verificar**

```bash
gcloud compute instances describe vpn-prod-vm --zone=us-central1-a \
  --format="value(metadata.items.filter(\"key:serial-port-enable\").extract(value))"
# Esperado: ['FALSE']
```

- [ ] **Step 4: Confirmar conexión SSH IAP sigue OK** (independiente, pero por las dudas)

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap --command="echo ok"
```

- [ ] **Step 5: Commit**

```bash
git add infra/compute.tf
git commit -m "security(vm): disable serial port on vpn-prod-vm"
```

**Rollback:** `serial-port-enable = "TRUE"`, `terraform apply`.

---

## Task 6 — Activar firewall logging en reglas VPN (P3)

**Problema:** `logConfig.enable=false` en `vpn-prod-fw-vpn`, `vpn-prod-fw-vpn-modern`, `vpn-prod-fw-https`. Sin logs no hay detección de scans/anomalías.

**Files:**
- Modify: `infra/firewall.tf` (3 reglas)

- [ ] **Step 1: Agregar bloque `log_config` a las 3 reglas**

En cada `google_compute_firewall` (`vpn_udp`, `vpn_udp_modern`, `https`) agregar antes del cierre:

```hcl
  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
```

> Nota: `vpn-prod-fw-iap-ssh` también puede recibir log (opcional, mismo patrón).

- [ ] **Step 2: Plan + apply**

```bash
cd infra
terraform plan
# Esperado: ~ 3 firewall rules in-place update
terraform apply
```

- [ ] **Step 3: Verificar logs llegando**

```bash
# Esperar 1-2 min después del apply, luego:
gcloud logging read 'resource.type=gce_subnetwork AND jsonPayload.rule_details.reference="network:vpn-prod-vpc/firewall:vpn-prod-fw-vpn"' \
  --limit=5 --format="value(timestamp,jsonPayload.connection.src_ip)"
```
Esperado: al menos 1 entrada en logs (asumiendo tráfico VPN activo).

- [ ] **Step 4: Verificar VPN clientes y panel siguen**

```bash
curl -sI https://vpn.we-do.io/ | head -1
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap \
  --command="docker exec openvpn cat /tmp/openvpn-status.log 2>/dev/null | grep -c 'CLIENT_LIST,'"
```

- [ ] **Step 5: Commit**

```bash
git add infra/firewall.tf
git commit -m "security(fw): enable logging on VPN firewall rules"
```

**Rollback:** quitar bloques `log_config`, `terraform apply`. (Logs históricos quedan en Cloud Logging hasta retention.)

> ⚠️ **Coste:** firewall logging genera tráfico billable (~$0.50/GB ingested). Para una VPN con tráfico moderado, < $5/mes. Verificar si preocupa.

---

## Task 7 — Limpieza red default: borrar `default-allow-ssh` y `default-allow-rdp` (P3, opcional)

**Contexto:** estas reglas están en la red `default` del proyecto. **No hay VMs en esa red hoy** (`vpn-prod-vm` corre en `vpn-prod-vpc`). No exponen nada *ahora*, pero higiene del proyecto y cierran finding SCC `OPEN_SSH_PORT`/`OPEN_RDP_PORT`.

> **Skip si:** otro equipo (ThingsBoard) podría agregar VMs a `default`. **Coordinar con ellos primero**.

**Files:** ninguno (no están en Terraform — son auto-creadas por GCP).

- [ ] **Step 1: Confirmar que no hay VMs ni recursos usándolas**

```bash
# VMs en default — debe ser vacío
gcloud compute instances list --filter="networkInterfaces.network~default$" --format="value(name)"
# Esperado: SIN salida
```

- [ ] **Step 2: Borrar reglas**

```bash
gcloud compute firewall-rules delete default-allow-ssh --quiet
gcloud compute firewall-rules delete default-allow-rdp --quiet
gcloud compute firewall-rules delete default-allow-icmp --quiet  # opcional, mismo caso
```

- [ ] **Step 3: Verificar findings SCC cerrados** (puede tardar minutos en re-evaluar)

```bash
gcloud scc findings list --location=global projects/integracion-tagoio \
  --filter="state=\"ACTIVE\" AND (category=\"OPEN_SSH_PORT\" OR category=\"OPEN_RDP_PORT\")" \
  --format="value(category,resourceName.basename())"
# Esperado: vacío (puede tardar hasta 1h en SCC re-scan)
```

- [ ] **Step 4: Verificar VPN VM sigue OK** (no debería afectarla — sanity check)

```bash
curl -sI https://vpn.we-do.io/ | head -1
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap --command="echo ok"
```

- [ ] **Step 5: Commit doc note** (no hay TF que cambiar)

Si querés dejar rastro:
```bash
# Editar docs/plan_security_hardening_vpn.md con check de Task 7 marcado
git add docs/plan_security_hardening_vpn.md
git commit -m "docs: mark default-network firewall cleanup complete"
```

**Rollback:** recrear reglas con `gcloud compute firewall-rules create default-allow-ssh --network=default --allow=tcp:22 --source-ranges=0.0.0.0/0` (idem rdp/icmp).

---

## Cierre

Tras completar Tasks 1-7:

- [ ] **Re-escanear SCC** y verificar que findings sobre `vpn-prod-vm` quedan en aceptables o cerrados:

```bash
gcloud scc findings list --location=global projects/integracion-tagoio \
  --filter="state=\"ACTIVE\" AND resourceName:\"vpn-prod-vm\"" --format="value(category,severity)"
```

Esperado restante (aceptables documentados):
- `PUBLIC_IP_ADDRESS` — necesario para VPN server
- `OPEN_FIREWALL` × 2 (vpn-prod-fw-vpn, vpn-prod-fw-vpn-modern) — UDP VPN abierto por diseño, mitigado por tls-crypt

- [ ] **Documentar excepciones** en `docs/security_exceptions.md` (justificación + revisor + fecha)

- [ ] **Nota — SA scope `cloud-platform`**: queda intencionalmente porque Task 2 agrega Secret Manager y los scopes legacy (`logging-write`, `monitoring-write`) no cubren Secret Manager bien. Control real está en IAM bindings (mínimos: logWriter, metricWriter, storage.objectAdmin sobre bucket backup, secretmanager.secretAccessor sobre 2 secrets). No reducir scope salvo audit IAM-vs-scope cuidadoso.

- [ ] **Push final**

```bash
git push origin master
```

---

## Resumen prioridad / esfuerzo

| Task | Pri | Downtime | Reversible | Riesgo cambio |
|------|-----|----------|------------|---------------|
| 1 — Restringir HTTPS panel | P0 | no | sí | bajo (si CIDR bien) |
| 2 — Secrets a Secret Manager | P0 | no | sí | medio (cambio en startup) |
| 3 — Secure Boot | P2 | ~2 min | sí | bajo |
| 4 — Verificar tls-crypt | P2 | no | n/a | nulo (lectura) |
| 5 — Apagar serial port | P3 | no | sí | nulo |
| 6 — Firewall logging | P3 | no | sí | nulo (cuesta $) |
| 7 — Cleanup default network | P3 | no | sí | nulo (red sin VMs) |

**Sugerencia ejecución:** 4 → 1 → 2 → 5 → 6 → 7 → 3.
(`4` primero porque es lectura y valida el supuesto que justifica `vpn-prod-fw-vpn` abierto. `3` al final porque es el único con downtime.)
