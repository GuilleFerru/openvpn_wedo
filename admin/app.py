"""
OpenVPN Admin — Flask entry point.
"""

# Logging must be configured before any module-level logger calls.
import logging_setup
logging_setup.setup_logging()

from datetime import timedelta
from flask import Flask
from flask_wtf.csrf import generate_csrf

from config import require_env
from extensions import csrf, limiter


def create_app():
    app = Flask(__name__)
    app.secret_key = require_env('SECRET_KEY')

    app.config.update(
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE='Lax',
        PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        WTF_CSRF_TIME_LIMIT=None,       # Token válido por toda la sesión
        WTF_CSRF_SSL_STRICT=False,      # Permitir Traefik como reverse proxy
    )

    csrf.init_app(app)
    limiter.init_app(app)

    @app.after_request
    def set_csrf_cookie(response):
        """Expose CSRF token as a JS-readable cookie (not httponly)."""
        response.set_cookie(
            'csrf_token',
            generate_csrf(),
            secure=True,
            samesite='Lax',
            httponly=False,
        )
        return response

    from blueprints.auth import bp as auth_bp
    from blueprints.groups import bp as groups_bp
    from blueprints.clients import bp as clients_bp

    app.register_blueprint(auth_bp)
    app.register_blueprint(groups_bp)
    app.register_blueprint(clients_bp)

    return app


app = create_app()

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8080)
