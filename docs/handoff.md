# Handoff — Migración del panel admin a React

**Fecha:** 2026-09-15
**Autor:** GuilleFerru (con asistencia Claude Code)
**Propósito:** Qué se hizo en la sesión del deploy de `react-redesign` y cómo seguir trabajando la UI en local

---

## TL;DR

La rama `react-redesign` (SPA de React 19 + Vite 8 + Tailwind 4) está **mergeada a master y corriendo en producción** en `https://vpn.we-do.io`. La VM quedó en `master`, rebuildeada desde ahí. Los 44 clientes conectados en campo no se cortaron en ningún momento.

La rama `react-redesign` sigue viva y sincronizada con master (`76a39b1`) para seguir iterando la UI.

**Lo único que falta verificar:** la UI a ojo en el browser. Todo lo que se validó fue a nivel HTTP/API.

---

## 1. Qué cambió la rama

Master ya tenía el refactor de blueprints, así que el diff fue puramente de frontend:

| Antes | Ahora |
|---|---|
| `admin/templates/index.html` (Jinja, 292 líneas) | SPA React montada en `<div id="root">` |
| `admin/static/css/style.css` (1463 líneas) | Tailwind 4, compilado por Vite |
| `admin/static/js/app.js` (666 líneas) | `admin/frontend/src/App.jsx` |
| `Dockerfile` single-stage | Multi-stage: build de Node → copia `dist/` a `static/` |

`admin/templates/login.html` se reescribió standalone (no depende de los CSS/JS borrados). Sigue usando `lucide.min.js` servido desde `static/`.

**Cómo se arma el bundle en producción:** el `Dockerfile` de `admin/` corre `npm ci && npm run build` en un stage `node:22-slim`, y copia `frontend/dist/` a `./static/` más `dist/index.html` sobre `./templates/index.html`. **La VM no necesita Node instalado.**

---

## 2. Bugs encontrados y corregidos

### 2.1 `vite.config.js` — `npm run dev` no servía nada

`base: '/static/'` convivía con una regla de proxy para `/static` apuntando al backend. Como el dev server sirve la app bajo `base`, esa regla interceptaba sus propios módulos y el cliente de HMR. Abrir `localhost:3000` daba:

```text
[vite] http proxy error: /static/
AggregateError [ECONNREFUSED]
```

Se sacó la regla `/static` del proxy y se agregaron `/login` y `/logout` para poder hacer todo el flujo desde `:3000`. **Solo afecta a dev** — el bundle de producción sale con hashes idénticos.

### 2.2 `App.jsx` — sesión expirada dejaba la UI congelada

Los endpoints protegidos responden **302 a `/login`**. `fetch` sigue el redirect y devuelve el HTML del login con status 200, así que `res.json()` tiraba `SyntaxError`. En `fetchStats` eso lo comía el `catch` con un `console.error` y el panel seguía mostrando datos viejos indefinidamente, sin ninguna señal.

Se agregó `apiFetch()` (módulo, arriba de `App`), que detecta el redirect y navega al login. Lo usan las 5 llamadas.

```js
async function apiFetch(url, options) {
  const res = await fetch(url, options);
  if (res.redirected && new URL(res.url).pathname === '/login') {
    window.location.href = '/login';
    throw new Error('session_expired');
  }
  return res;
}
```

Comportamiento confirmado contra producción: `/api/clients` sin sesión → `302` → `200 text/html`.

### 2.3 `docker-compose.local.yml` — dev local roto

Montaba `./admin:/app`, lo que tapaba `/app/static` y `/app/templates/index.html`. Esos dos los genera Vite durante el build y **no existen en el repo**, así que Flask arrancaba y después fallaba con `TemplateNotFound` en `/`.

Se reemplazó por mounts puntuales de los archivos Python (mismo hot-reload, sin pisar el frontend). También se sacó el `pip install watchdog` del `command`: el container corre como `appuser` (no root) y el reloader por stat de werkzeug alcanza sobre bind mounts de Docker Desktop.

### 2.4 Build

- `node:20-slim` → `node:22-slim`. Vite 8 pide `^20.19.0 || >=22.12.0` y Node 20 ya está EOL; con el tag `20-slim` el build dependía de que resolviera a 20.19+.
- `npm install` → `npm ci`. El `package-lock.json` está commiteado.
- `admin/.dockerignore` tenía **BOM UTF-8**, con lo cual el primer patrón quedaba como `\ufeff__pycache__` y no matcheaba nada. Reescrito sin BOM, más `frontend/dist/`.

### 2.5 Limpieza

Restos del template de Vite que habían quedado: `App.css` (184 líneas, nunca importado), `hero.png`, `react.svg`, `vite.svg`, `public/favicon.svg`, `public/icons.svg`, e imports sin uso `Menu` y `Settings`.

Borrar `App.css` bajó el CSS de **23.75 → 22.08 kB**: Tailwind 4 escanea *todos* los archivos buscando candidatos de utilidades y le estaba generando clases fantasma a partir de esas reglas.

### 2.6 Infra — swap en la VM

La `e2-small` tiene 2 GB de RAM y arrancaba **sin swap**. Ahora el Dockerfile corre un build de Node/Vite adentro, y un pico de RAM podía disparar el OOM killer contra los containers de producción.

Se agregó un bloque idempotente de swapfile de 2 GB en `infra/scripts/startup.sh` y se aplicó a mano en la VM. En la práctica el build usó 0 de swap (tarda ~64s), pero queda de red.

> **Ojo:** `infra/compute.tf` tiene `ignore_changes` sobre `metadata_startup_script`. Editar `startup.sh` **no** se aplica solo — hay que replicarlo a mano por SSH, o recrear la VM.

---

## 3. Procedimiento de deploy (importante)

`/opt/vpn` en la VM es un clone del repo. Para redeployar solo el panel **sin cortar los gateways**:

```bash
gcloud compute ssh vpn-prod-vm --zone=us-central1-a --tunnel-through-iap

cd /opt/vpn
sudo git pull --ff-only origin master
sudo docker compose build openvpn-admin
sudo docker compose up -d --no-deps openvpn-admin
```

**El `--no-deps` es lo crítico.** Sin él, compose evalúa `depends_on` y puede recrear `openvpn` / `openvpn-modern`, tirando abajo las sesiones de los gateways en campo.

Antes de recrear, taguear la imagen anterior da rollback instantáneo:

```bash
sudo docker tag $(sudo docker inspect openvpn-admin --format '{{.Image}}') openvpn-admin:rollback-$(date +%F)
```

---

## 4. Verificación hecha

Smoke test corrido en la VM contra Traefik (`--resolve vpn.we-do.io:443:127.0.0.1`) después de cada build. Todo en verde:

| Check | Resultado |
|---|---|
| `GET /` sin auth | 302 → `/login` |
| `GET /login` | 200, `csrf_token` presente |
| `POST /login` | 302 → `/` |
| `GET /` autenticado | 200, index de React |
| `/static/assets/*.js` · `*.css` | 200 — hashes idénticos al build local |
| `/api/clients` · `/groups` · `/connected` · `/next-group-range` | 200 JSON |
| Assets de `login.html` | 200 |
| `POST` sin `X-CSRFToken` | 400 (rechaza) |
| `POST` con `X-CSRFToken` | 200 (pasa a validación, sin efecto) |
| `/health` | 200 |

Los hashes del bundle buildeado en la VM coinciden exactamente con el build local → `npm ci` reproducible.

**Los daemons de OpenVPN no se tocaron.** 44 clientes conectados (43 en daemon1, 1 en daemon2), con sesiones desde el 4/9 sin cortarse.

### Lo que NO se verificó

- **La UI a ojo.** `agent-browser` cuelga en esta máquina (incluso con `example.com`), así que no se llegó a abrir el panel en un browser. **Conviene mirarlo:** `https://vpn.we-do.io` (tu IP está whitelisted en `infra/terraform.tfvars`).
- **`docker-compose.local.yml` corriendo.** Docker Desktop no estaba levantado en la máquina local. Se validó la sintaxis con `docker compose config` en la VM, pero no el arranque real.

---

## 5. Cómo seguir trabajando la UI en local

La rama `react-redesign` está sincronizada con `master` (`76a39b1`) y el working tree limpio.

```bash
cd C:\Users\EDC-PC09\Documents\repos\openvpn_wedo
git checkout react-redesign
git pull
```

### Paso 1 — backend

```bash
docker compose -f docker-compose.local.yml up -d --build
```

Levanta Flask en `:8080` con hot-reload de Python. Los containers de OpenVPN quedan mockeados (`tail -f /dev/null`) si no hay config, así que no hace falta PKI para trabajar la UI.

Login en <http://localhost:8080/login>, password **`admin`** (hardcodeada en `docker-compose.local.yml`, solo local).

> Si el panel arranca sin datos, es normal: `clients/clients.json` local no tiene los clientes de producción. Para tener datos realistas se puede bajar una copia:
>
> ```bash
> gcloud compute scp vpn-prod-vm:/mnt/vpn-data/clients/clients.json ./clients/ \
>   --zone=us-central1-a --tunnel-through-iap
> ```

### Paso 2 — frontend con HMR

```bash
cd admin/frontend
npm ci        # solo la primera vez
npm run dev
```

Abrir <http://localhost:3000> — redirige a `/static/`, que es donde Vite sirve la app (por el `base: '/static/'`).

Vite proxea `/api`, `/download`, `/login` y `/logout` a Flask en `:8080`. **`/static` no se proxea a propósito** (ver §2.1). La cookie de sesión viaja entre `:8080` y `:3000` porque las cookies ignoran el puerto.

### Paso 3 — verificar antes de commitear

```bash
cd admin/frontend
npm run lint
npm run build
```

`npm run build` es la verificación que importa: es exactamente lo que va a correr el Dockerfile en la VM.

Warnings de `oxlint` que ya existen y son ruido conocido: tres `catch (err)` sin usar y un `set-state-in-effect` en el `fetchStats` del mount.

### Paso 4 — probar el bundle compilado

Para ver el frontend como lo sirve Flask (no el dev server):

```bash
docker compose -f docker-compose.local.yml up -d --build openvpn-admin
```

Y abrir <http://localhost:8080>.

### Paso 5 — mergear a master

Cuando esté listo:

```bash
git checkout master && git pull
git merge --no-ff react-redesign
git push origin master
```

Y después el deploy de §3.

---

## 6. Mapa de archivos

```text
admin/
  Dockerfile              multi-stage: node:22-slim build → python:3.11-slim
  .dockerignore           sin BOM (ver §2.4)
  app.py                  create_app, CSP, cookie csrf_token, headers de seguridad
  blueprints/
    auth.py               /login /logout / /health
    clients.py            /api/clients /connected /rejected /create /revoke /download/<name>
    groups.py             /api/groups /next-group-range /recalculate
  templates/
    login.html            standalone, Tailwind inline + lucide
    index.html            NO está en el repo — lo genera Vite en el build
  static/
    img/ js/lucide.min.js los que sí están versionados
    assets/               NO está en el repo — lo genera Vite en el build
  frontend/
    vite.config.js        base '/static/' + proxy (ver §2.1)
    index.html            template de la SPA
    src/
      main.jsx            monta <App/>
      App.jsx             toda la UI + apiFetch()
      index.css           Tailwind + tokens WeDo + overrides de dark mode
    public/
      favicon.png
      img/wedo-logo.png

docker-compose.yml        producción (Traefik + 2 daemons + admin)
docker-compose.local.yml  desarrollo (sin Traefik, admin expuesto en :8080)
infra/scripts/startup.sh  bootstrap de la VM — incluye el swapfile
```

---

## 7. Deuda conocida / próximos pasos

- **Verificar la UI en el browser.** Es lo único del deploy que quedó sin confirmar.
- **Refresco cada 30s**: `App.jsx` dispara 3 requests en paralelo (`/api/connected`, `/clients`, `/groups`) contra gunicorn con **2 workers sync**. Con varias pestañas abiertas se puede saturar — `/api/connected` es el lento porque hace `docker exec` contra el container de OpenVPN. Si molesta, subir workers o consolidar en un endpoint.
- **`docs/deploy_status.md` y `docs/plan_dns_remote_ovpn.md`** siguen describiendo el panel viejo (Jinja + `style.css` + `app.js`). Convendría actualizarlos.
- **Tema oscuro**: `index.css` tiene overrides bastante ad-hoc (`.dark .text-slate-800 { @apply text-slate-200 }` y similares). Funciona, pero conviene migrar a tokens semánticos si se sigue creciendo la UI.
