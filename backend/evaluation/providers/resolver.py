"""Resolves a ModelSpec's provider string to a configured ModelClient.

Adding a model on an already-supported provider is a new row in the
registry, not a code change here.
"""

from collections.abc import Callable

from evaluation.contracts import ModelClient, ModelSpec
from evaluation.providers.google_ai_studio import GoogleAIStudioClient
from evaluation.providers.openai_compatible import AuthScheme, OpenAICompatibleClient

AZURE_BASE_URL = "https://aibirzeit.openai.azure.com/openai/v1"


def resolve_client(
    spec: ModelSpec,
    *,
    google_api_key: str | None,
    azure_api_key: str | None,
) -> ModelClient:
    """Build the ModelClient serving spec.provider, injected with its API key.

    Per-model settings (reasoning level, timeout, token-parameter name) travel
    on the spec; base URL and auth scheme are
    per-provider here. Raises ValueError naming the unsupported provider and
    the supported ones if none matches.
    """
    factories: dict[str, Callable[[], ModelClient]] = {
        "google_ai_studio": lambda: GoogleAIStudioClient(api_key=google_api_key),
        "azure_ai_foundry": lambda: OpenAICompatibleClient(
            base_url=AZURE_BASE_URL,
            api_key=azure_api_key,
            auth_scheme=AuthScheme.api_key_header,
        ),
    }

    factory = factories.get(spec.provider)
    if factory is None:
        supported = ", ".join(sorted(factories))
        raise ValueError(f"Unsupported provider '{spec.provider}'. Supported providers: {supported}.")
    return factory()
