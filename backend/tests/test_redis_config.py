"""Connection settings shared by the ARQ producer and worker."""

import os
import subprocess
import sys

from app.redis_config import redis_settings_from_url


def test_local_redis_url():
    settings = redis_settings_from_url("redis://redis:6379/0")

    assert settings.host == "redis"
    assert settings.port == 6379
    assert settings.database == 0
    assert settings.ssl is False


def test_external_redis_url_uses_tls_and_decodes_credentials():
    settings = redis_settings_from_url(
        "rediss://user%40example:pass%3Aword%40encoded@redis.example.com:6380/2"
    )

    assert settings.host == "redis.example.com"
    assert settings.port == 6380
    assert settings.database == 2
    assert settings.username == "user@example"
    assert settings.password == "pass:word@encoded"
    assert settings.ssl is True
    assert settings.ssl_cert_reqs == "required"
    assert settings.ssl_check_hostname is True


def test_producer_and_worker_use_the_same_external_connection():
    env = os.environ.copy()
    env.update(
        DATABASE_URL="sqlite+aiosqlite:///:memory:",
        JWT_SECRET_KEY="test-secret",
        REDIS_URL="rediss://default:pass%40word@redis.example.com:6380/0",
    )
    script = """
import asyncio
from unittest.mock import AsyncMock, patch

from app.services import run_service
from worker.main import WorkerSettings

async def check():
    with patch.object(run_service.arq, "create_pool", new_callable=AsyncMock) as create_pool:
        await run_service._get_redis_pool()
        producer = create_pool.await_args.args[0]
        worker = WorkerSettings.redis_settings
        assert producer == worker
        assert producer.host == "redis.example.com"
        assert producer.password == "pass@word"
        assert producer.ssl and producer.ssl_check_hostname

asyncio.run(check())
"""
    subprocess.run([sys.executable, "-c", script], env=env, check=True)
