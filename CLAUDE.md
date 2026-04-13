# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OpenVPN administration system with a web panel for managing clients organized into network-isolated groups. Supports up to 255 groups × 254 clients on a 10.8.0.0/16 subnet. Documentation and comments are in Spanish.

## Build & Run Commands

```bash
# Initial server setup (run once)
./setup.sh <PUBLIC_IP>

# Start services
docker compose up -d

# Rebuild after code changes
docker compose up -d --build

# View logs
docker compose logs -f openvpn-admin

# CLI client management (alternative to web panel)
./create-client.sh
./revoke-client.sh
./list-clients.sh
```

There are no tests, linters, or CI pipelines configured.

## Approach
- Think before acting. Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
- No sycophantic openers or closing fluff.
- Keep solutions simple and direct.
- User instructions always override this file.
- **Mantener local y remoto sincronizados.** Cualquier fix aplicado por SSH/manualmente en la VM de producción debe replicarse inmediatamente en el código local (Terraform, `infra/scripts/startup.sh`, `docker-compose.yml`, etc.) para que un redeploy limpio no reintroduzca el bug. Aplica en ambos sentidos: cambios locales deben llegar a la VM, y hotfixes en la VM deben llegar al repo.

## Architecture

**Stack**: Python 3.11 / Flask backend, vanilla JS frontend, Docker Compose orchestration, JSON file as database (`clients/clients.json`).

**Two containers** (defined in `docker-compose.yml`):
- `openvpn` — kylemanna/openvpn image, UDP 1194, with iptables rules for group isolation
- `openvpn-admin` — Flask app (port 8888→8080), built from `admin/Dockerfile`

**Backend** (`admin/app.py`, single-file monolith ~824 lines):
- All Flask routes, helpers, and business logic in one file
- REST API under `/api/` for groups, clients, connections, revocation
- Authentication via simple password from `ADMIN_PASSWORD` env var
- IP assignment: group number maps to third octet (group N → 10.8.N.x)
- Client operations shell out to Docker CLI to run OpenVPN commands inside the VPN container

**Frontend** (`admin/templates/` + `admin/static/`):
- `index.html` — dashboard with collapsible sections
- `app.js` — API calls, theme toggle, section state persistence via localStorage
- `style.css` — dark/light theme, responsive layout

**Data flow**: Web panel → Flask API → Docker CLI → OpenVPN container → generates .ovpn files + CCD entries in mounted volumes (`clients/`, `ccd/`).

## Environment Variables

Defined in `.env` (see `.env.example`):
- `ADMIN_PASSWORD` — web panel login password
- `SECRET_KEY` — Flask session secret
- `LOCAL_SERVER_IP` — local VM IP for dual-remote in .ovpn configs

## knowledge base
- C:\Users\EDC-PC09\Documents\repos\openvpn_wedo\docs

