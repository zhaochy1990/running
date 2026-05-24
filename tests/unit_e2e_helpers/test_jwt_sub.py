"""Unit tests for tests/e2e/_jwt.py — decode `sub` without signature check."""
from __future__ import annotations

import jwt
import pytest

from tests.e2e._jwt import JwtError, extract_sub


def _token(payload: dict) -> str:
    return jwt.encode(payload, key="unused-secret", algorithm="HS256")


def test_extracts_sub_claim() -> None:
    token = _token({"sub": "550e8400-e29b-41d4-a716-446655440000", "iss": "auth-service"})
    assert extract_sub(token) == "550e8400-e29b-41d4-a716-446655440000"


def test_missing_sub_raises() -> None:
    token = _token({"iss": "auth-service"})
    with pytest.raises(JwtError) as exc:
        extract_sub(token)
    assert "sub" in str(exc.value)


def test_empty_sub_raises() -> None:
    token = _token({"sub": ""})
    with pytest.raises(JwtError) as exc:
        extract_sub(token)
    assert "sub" in str(exc.value)


def test_garbage_token_raises() -> None:
    with pytest.raises(JwtError):
        extract_sub("not-a-jwt")
