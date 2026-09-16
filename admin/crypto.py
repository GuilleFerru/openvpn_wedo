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
            with open(KEY_FILE, 'wb') as f:
                f.write(key)
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
