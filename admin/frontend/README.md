# Panel admin — frontend

SPA de React (React 19 + Vite 8 + Tailwind 4) que consume la API Flask de
`admin/`. El build de producción lo hace el `Dockerfile` de `admin/` en un stage
de Node y copia el resultado a `static/` + `templates/index.html`, así que en la
VM no hace falta Node instalado.

Requiere Node >= 22.12 (o >= 20.19) — es lo que pide Vite 8.

## Desarrollo local

Hay dos formas de trabajar. Las dos necesitan el backend corriendo:

```bash
# Desde la raíz del repo — levanta Flask en :8080 con hot-reload de Python
docker compose -f docker-compose.local.yml up -d --build
```

Login en <http://localhost:8080/login> con la password `admin` (está hardcodeada
en `docker-compose.local.yml`, es solo para local).

### A. Editar el frontend con HMR (lo normal)

```bash
cd admin/frontend
npm ci        # solo la primera vez
npm run dev
```

Abrir <http://localhost:3000> — redirige a `/static/`, que es donde Vite sirve la
app (por el `base: '/static/'`).

Vite proxea `/api`, `/download`, `/login` y `/logout` a Flask en `:8080`; todo lo
demás lo sirve el propio dev server con HMR. **`/static` no se proxea a
propósito**: colisionaría con `base` y el dev server terminaría mandando al
backend sus propios módulos y el cliente de HMR.

La cookie de sesión también viaja entre `:8080` y `:3000` porque las cookies
ignoran el puerto, así que si ya te logueaste en `:8080` no hace falta de nuevo.

### B. Probar el bundle ya compilado

`http://localhost:8080` sirve el frontend que quedó adentro de la imagen. Para
ver cambios del frontend ahí hay que rebuildear:

```bash
docker compose -f docker-compose.local.yml up -d --build openvpn-admin
```

El compose local monta **solo los archivos Python** dentro del container. No
monta `admin/` entero a propósito: eso taparía `/app/static` y
`/app/templates/index.html`, que los genera Vite durante el build y no existen
en el repo.

## Comandos

```bash
npm run dev       # dev server con HMR en :3000
npm run build     # build de producción a dist/
npm run preview   # servir dist/ para verificar el build
npm run lint      # oxlint
```

## Estructura

```
src/
  main.jsx     punto de entrada, monta <App/>
  App.jsx      toda la UI del panel (dashboard, clientes, grupos, alta, revocación)
  index.css    Tailwind + tokens de color WeDo + overrides de dark mode
public/
  favicon.png
  img/wedo-logo.png
```

`base: '/static/'` en `vite.config.js` es lo que hace que los assets se
referencien como `/static/assets/...`, que es donde Flask los sirve.
