FROM node:20-slim AS frontend-builder
WORKDIR /app/frontend
# Copiar dependencias de Node
COPY frontend/package*.json ./
RUN npm install
# Copiar el codigo y hacer la build de produccion
COPY frontend/ ./
RUN npm run build

FROM python:3.11-slim
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Docker CLI
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -fsSL -o /tmp/docker.tgz \
       https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    && tar xzf /tmp/docker.tgz --strip-components 1 -C /usr/bin docker/docker \
    && rm /tmp/docker.tgz \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -m -u 1000 appuser

COPY --chown=appuser:appuser app.py config.py extensions.py logging_setup.py network.py db.py vpn.py ./
COPY --chown=appuser:appuser blueprints/ blueprints/
COPY --chown=appuser:appuser templates/ templates/
COPY --chown=appuser:appuser static/ static/

# Copiar los assets generados por Vite (js/css/favicon) a la carpeta static
COPY --from=frontend-builder --chown=appuser:appuser /app/frontend/dist/ ./static/
# Copiar el index.html y sobreescribir el de templates/
COPY --from=frontend-builder --chown=appuser:appuser /app/frontend/dist/index.html ./templates/index.html

USER appuser
EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "300", "app:app"]
