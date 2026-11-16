"""Shared ARQ connection settings for local and external Redis instances."""

from urllib.parse import unquote

from arq.connections import RedisSettings


def redis_settings_from_url(url: str) -> RedisSettings:
    redis_settings = RedisSettings.from_dsn(url)
    if redis_settings.username is not None:
        redis_settings.username = unquote(redis_settings.username)
    if redis_settings.password is not None:
        redis_settings.password = unquote(redis_settings.password)
    if redis_settings.ssl:
        redis_settings.ssl_check_hostname = True
    return redis_settings
