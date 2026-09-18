import os
from cryptography.fernet import Fernet, InvalidToken
from config import CLIENTS_DIR

KEY_FILE = os.path.join(CLIENTS_DIR, 'secret.key')
_fernet_instance = None

def get_fernet():
    global _fernet_instance
    if _fernet_instance is None:
        if os.path.exists(KEY_FILE):
            with open(KEY_FILE, 'rb') as f:
                key = f.read()
        else:
            key = Fernet.generate_key()
            os.makedirs(CLIENTS_DIR, exist_ok=True)
            # Crear con 0600 desde el arranque: con open() a secas quedaba
            # 0644 (world-readable) y la clave vive en el mismo directorio
            # que el clients.json que descifra.
            fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as f:
                f.write(key)
        try:
            os.chmod(KEY_FILE, 0o600)
        except OSError:
            # Windows/bind mounts de dev pueden no soportar chmod.
            pass
        _fernet_instance = Fernet(key)
    return _fernet_instance

def encrypt_password(plain_text):
    if not plain_text:
        return plain_text
    f = get_fernet()
    return f.encrypt(plain_text.encode('utf-8')).decode('utf-8')

def decrypt_password(cipher_text):
    if not cipher_text:
        return cipher_text
    f = get_fernet()
    try:
        return f.decrypt(cipher_text.encode('utf-8')).decode('utf-8')
    except (InvalidToken, ValueError, TypeError):
        # Fallback to plain text if it wasn't encrypted (e.g. from previous beta version)
        return cipher_text
