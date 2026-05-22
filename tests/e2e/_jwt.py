"""Decode the `sub` claim from a JWT without verifying the signature.

We only call this on a token we just received from the auth-service over
TLS — verification happens server-side at request time via the public key
config. Here we just want the UUID for URL building.
"""
from __future__ import annotations

import jwt


class JwtError(RuntimeError):
    """Raised when the token cannot be decoded or has no usable `sub`."""


def extract_sub(token: str) -> str:
    try:
        payload = jwt.decode(token, options={"verify_signature": False})
    except jwt.PyJWTError as e:
        raise JwtError(f"failed to decode JWT: {e}") from e
    sub = payload.get("sub")
    if not isinstance(sub, str) or not sub.strip():
        raise JwtError("JWT payload has no `sub` claim (or it is empty)")
    return sub
