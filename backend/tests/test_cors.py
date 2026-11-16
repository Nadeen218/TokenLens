"""CORS configuration for wildcard and explicit origins."""

import os
import subprocess
import sys

import pytest


@pytest.mark.parametrize(
    ("allowed_origins", "origin", "expected_status", "expected_credentials"),
    [
        ("*", "https://other.example", 200, False),
        ("https://allowed.example", "https://allowed.example", 200, True),
        ("https://allowed.example", "https://other.example", 400, True),
    ],
)
def test_cors_preflight(allowed_origins, origin, expected_status, expected_credentials):
    env = os.environ.copy()
    env.update(
        DATABASE_URL="sqlite+aiosqlite:///:memory:",
        REDIS_URL="redis://localhost:6379/0",
        JWT_SECRET_KEY="test-secret",
        CORS_ALLOWED_ORIGINS=allowed_origins,
        TEST_ORIGIN=origin,
        TEST_EXPECTED_STATUS=str(expected_status),
        TEST_EXPECTED_CREDENTIALS=str(expected_credentials),
    )
    script = """
import os
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import app

assert Settings.model_fields["cors_allowed_origins"].default == "*"
response = TestClient(app).options(
    "/auth/login",
    headers={
        "Origin": os.environ["TEST_ORIGIN"],
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type",
    },
)
assert response.status_code == int(os.environ["TEST_EXPECTED_STATUS"])
assert (response.headers.get("access-control-allow-credentials") == "true") == (
    os.environ["TEST_EXPECTED_CREDENTIALS"] == "True"
)
if response.status_code == 200:
    expected_origin = "*" if os.environ["CORS_ALLOWED_ORIGINS"] == "*" else os.environ["TEST_ORIGIN"]
    assert response.headers["access-control-allow-origin"] == expected_origin
"""
    subprocess.run([sys.executable, "-c", script], env=env, check=True)
