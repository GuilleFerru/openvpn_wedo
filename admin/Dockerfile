FROM python:3.11-slim

WORKDIR /app

# Install Python dependencies (pinned versions)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Install Docker CLI with explicit version
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -fsSL -o /tmp/docker.tgz \
       https://download.docker.com/linux/static/stable/x86_64/docker-27.5.1.tgz \
    && tar xzf /tmp/docker.tgz --strip-components 1 -C /usr/bin docker/docker \
    && rm /tmp/docker.tgz \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Non-root user
# The Docker socket GID varies by host; we grant access via group at runtime.
# Docker Desktop on Windows typically sets the socket world-accessible.
RUN useradd -m -u 1000 appuser

COPY --chown=appuser:appuser app.py config.py extensions.py logging_setup.py network.py db.py vpn.py ./
COPY --chown=appuser:appuser blueprints/ blueprints/
COPY --chown=appuser:appuser templates/ templates/
COPY --chown=appuser:appuser static/ static/

USER appuser

EXPOSE 8080

# Gunicorn: 2 workers, 300s timeout (cert generation can take ~60-120s)
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "300", "app:app"]
