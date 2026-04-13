import logging
from pythonjsonlogger import jsonlogger


def setup_logging():
    handler = logging.StreamHandler()
    formatter = jsonlogger.JsonFormatter(
        fmt='%(asctime)s %(levelname)s %(name)s %(message)s',
        datefmt='%Y-%m-%dT%H:%M:%SZ',
    )
    handler.setFormatter(formatter)
    root = logging.getLogger()
    root.handlers = []
    root.addHandler(handler)
    root.setLevel(logging.INFO)
    # Suppress noisy werkzeug access logs in production (gunicorn handles them)
    logging.getLogger('werkzeug').setLevel(logging.WARNING)
