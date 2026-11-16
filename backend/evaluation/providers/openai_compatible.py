"""Adapter for any OpenAI-compatible chat-completions endpoint — serves Azure AI
Foundry. Base URL and auth scheme are per-provider constructor arguments;
which parameters a deployment accepts (token-limit name and reasoning_effort)
vary per model and travel on the ModelSpec.
"""

import time
from enum import Enum
from typing import Any

import httpx

from evaluation.contracts import (
    CallStatus,
    CompletionOutcome,
    ModelClient,
    ModelResponse,
    ModelSpec,
    PriceSnapshot,
)
from evaluation.providers._shared import (
    build_price_snapshot,
    elapsed_ms,
    estimate_tokens,
    failed_response,
    resolve_timeout_seconds,
    status_error_message,
)

_FINISH_REASON_OUTCOMES = {
    None: CompletionOutcome.normal,
    "stop": CompletionOutcome.normal,
    "length": CompletionOutcome.truncated,
    "content_filter": CompletionOutcome.content_filtered,
}


class AuthScheme(str, Enum):
    """How the API key is presented: Groq/NVIDIA use a Bearer token, Azure an api-key header."""

    bearer = "bearer"
    api_key_header = "api_key_header"


class OpenAICompatibleClient(ModelClient):
    """Serves an OpenAI-compatible chat-completions endpoint (Azure AI Foundry).

    Reasoning text (message.reasoning_content / message.reasoning) is dropped
    rather than appended to output_text, so the judge grades the answer and
    not the model's thinking; only its token count is kept.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
        auth_scheme: AuthScheme = AuthScheme.bearer,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._auth_scheme = auth_scheme
        self._transport = transport

    async def complete(
        self,
        spec: ModelSpec,
        prompt: str,
        system_prompt: str | None,
        temperature: float,
        max_output_tokens: int,
    ) -> ModelResponse:
        prices_snapshot = build_price_snapshot(spec)

        if not self._api_key:
            return failed_response(0, prices_snapshot, f"No API key configured for provider '{spec.provider}'.")

        payload = _build_payload(spec, prompt, system_prompt, max_output_tokens)
        headers = self._auth_headers()
        timeout_seconds = resolve_timeout_seconds(spec)

        started_at = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=timeout_seconds, transport=self._transport) as client:
                response = await client.post(f"{self._base_url}/chat/completions", json=payload, headers=headers)
            latency_ms = elapsed_ms(started_at)
            response.raise_for_status()
        except httpx.TimeoutException:
            return failed_response(
                elapsed_ms(started_at),
                prices_snapshot,
                f"Request to {spec.provider} timed out after {timeout_seconds}s.",
            )
        except httpx.HTTPStatusError as error:
            return failed_response(elapsed_ms(started_at), prices_snapshot, status_error_message(spec, error))
        except httpx.HTTPError as error:
            return failed_response(elapsed_ms(started_at), prices_snapshot, f"Request to {spec.provider} failed: {error}.")

        try:
            return _parse_success(response.json(), prompt, system_prompt, latency_ms, prices_snapshot)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            return failed_response(latency_ms, prices_snapshot, f"Malformed response from {spec.provider}: {error}.")

    def _auth_headers(self) -> dict[str, str]:
        if self._auth_scheme is AuthScheme.api_key_header:
            return {"api-key": self._api_key or ""}
        return {"Authorization": f"Bearer {self._api_key}"}


def _build_payload(
    spec: ModelSpec,
    prompt: str,
    system_prompt: str | None,
    max_output_tokens: int,
) -> dict[str, Any]:
    """Shape the request to what this deployment accepts."""
    messages: list[dict[str, str]] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})

    token_param = "max_completion_tokens" if spec.uses_max_completion_tokens else "max_tokens"
    payload: dict[str, Any] = {"model": spec.model_name, "messages": messages, token_param: max_output_tokens}
    if spec.reasoning_level is not None:
        payload["reasoning_effort"] = spec.reasoning_level
    if spec.response_format is not None:
        payload["response_format"] = {"type": spec.response_format}
    return payload


def _completion_outcome(choice: dict[str, Any], data: dict[str, Any]) -> CompletionOutcome:
    outcome = _FINISH_REASON_OUTCOMES.get(choice.get("finish_reason"), CompletionOutcome.other)
    if outcome is CompletionOutcome.content_filtered or _is_content_filtered(choice, data):
        return CompletionOutcome.content_filtered
    return outcome


def _is_content_filtered(choice: dict[str, Any], data: dict[str, Any]) -> bool:
    """True when Azure's per-choice or per-prompt content_filter_results flag any category as filtered."""
    per_prompt = [entry.get("content_filter_results") for entry in data.get("prompt_filter_results") or []]
    for results in [choice.get("content_filter_results"), *per_prompt]:
        if isinstance(results, dict) and any(
            isinstance(category, dict) and category.get("filtered") for category in results.values()
        ):
            return True
    return False


def _parse_success(
    data: dict[str, Any],  # the provider's JSON response shape, not ours to type
    prompt: str,
    system_prompt: str | None,
    latency_ms: int,
    prices_snapshot: PriceSnapshot,
) -> ModelResponse:
    choice = data["choices"][0]
    completion_outcome = _completion_outcome(choice, data)

    message = choice["message"]
    output_text = message.get("content") or ""
    reasoning_text = message.get("reasoning_content") or message.get("reasoning") or ""

    usage = data.get("usage")
    if usage is None:
        input_tokens = estimate_tokens(f"{system_prompt or ''} {prompt}")
        output_tokens = estimate_tokens(output_text)
        reasoning_tokens = estimate_tokens(reasoning_text)
        cached_tokens = 0
        tokens_estimated = True
    else:
        prompt_tokens = usage.get("prompt_tokens", 0)
        completion_tokens = usage.get("completion_tokens", 0)
        cached_tokens = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
        reasoning_tokens = (usage.get("completion_tokens_details") or {}).get("reasoning_tokens", 0)
        input_tokens = max(prompt_tokens - cached_tokens, 0)
        output_tokens = max(completion_tokens - reasoning_tokens, 0)
        tokens_estimated = False

    return ModelResponse(
        output_text=output_text,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_tokens=cached_tokens,
        reasoning_tokens=reasoning_tokens,
        latency_ms=latency_ms,
        attempts=1,
        status=CallStatus.ok,
        completion_outcome=completion_outcome,
        tokens_estimated=tokens_estimated,
        prices_snapshot=prices_snapshot,
    )
