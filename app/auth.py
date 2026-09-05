from __future__ import annotations

import os
import secrets
from pathlib import Path

import bcrypt
from itsdangerous import BadSignature, URLSafeSerializer

COOKIE_TEACHER = "teachqrs_teacher"
COOKIE_STUDENT = "teachqrs_student"


def load_secret(data_dir: Path) -> str:
    env = os.environ.get("TEACHQRS_SECRET")
    if env:
        return env
    data_dir.mkdir(parents=True, exist_ok=True)
    path = data_dir / "secret.txt"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    secret = secrets.token_hex(32)
    path.write_text(secret, encoding="utf-8")
    return secret


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except ValueError:
        return False


def make_signer(secret: str) -> URLSafeSerializer:
    return URLSafeSerializer(secret, salt="teachqrs-v1")


def dumps(signer: URLSafeSerializer, payload: dict) -> str:
    return signer.dumps(payload)


def loads(signer: URLSafeSerializer, token: str | None) -> dict | None:
    if not token:
        return None
    try:
        data = signer.loads(token)
    except BadSignature:
        return None
    return data if isinstance(data, dict) else None
