"""Ed25519 signing for audit events. The private key never leaves .factory-keys/ (git-ignored);
anyone holding the public key can verify that the factory, and only the factory, wrote the log."""
import base64
import hashlib
import os
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

from factory.config import ROOT

KEY_DIR = Path(os.environ.get("FACTORY_KEY_DIR", ROOT / ".factory-keys"))
_private: Ed25519PrivateKey | None = None


def _private_key() -> Ed25519PrivateKey:
    global _private
    if _private is None:
        path = KEY_DIR / "audit_ed25519.pem"
        if path.exists():
            _private = serialization.load_pem_private_key(path.read_bytes(), password=None)
        else:
            KEY_DIR.mkdir(parents=True, exist_ok=True)
            _private = Ed25519PrivateKey.generate()
            path.write_bytes(_private.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                    serialization.NoEncryption()))
            path.chmod(0o600)
            (KEY_DIR / "audit_ed25519.pub").write_bytes(public_pem())
    return _private


def public_pem() -> bytes:
    return _private_key().public_key().public_bytes(serialization.Encoding.PEM,
                                                    serialization.PublicFormat.SubjectPublicKeyInfo)


def key_id(public: Ed25519PublicKey | None = None) -> str:
    public = public or _private_key().public_key()
    raw = public.public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return hashlib.sha256(raw).hexdigest()[:16]


def sign(message: str) -> str:
    return base64.b64encode(_private_key().sign(message.encode())).decode()


def load_public(path: Path | None = None) -> Ed25519PublicKey:
    if path is None:
        return _private_key().public_key()
    return serialization.load_pem_public_key(path.read_bytes())


def verify(public: Ed25519PublicKey, message: str, signature: str) -> bool:
    try:
        public.verify(base64.b64decode(signature), message.encode())
        return True
    except (InvalidSignature, ValueError):
        return False
