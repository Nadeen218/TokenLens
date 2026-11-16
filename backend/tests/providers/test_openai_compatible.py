import json

import httpx

from evaluation.contracts import CallStatus, CompletionOutcome
from evaluation.providers._shared import DEFAULT_REQUEST_TIMEOUT_SECONDS
from evaluation.providers.openai_compatible import AuthScheme, OpenAICompatibleClient
from tests.providers.conftest import make_spec


def _client(handler, api_key: str | None = "test-key") -> OpenAICompatibleClient:
    return OpenAICompatibleClient(
        base_url="https://example-provider.test/v1",
        api_key=api_key,
        transport=httpx.MockTransport(handler),
    )


async def test_reasoning_content_is_dropped_and_split_out_of_output_tokens(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {
                            "content": "The final answer is 4.",
                            "reasoning_content": "Let me think step by step about 2+2...",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 12,
                    "completion_tokens": 46,
                    "completion_tokens_details": {"reasoning_tokens": 40},
                },
            },
        )

    response = await _client(handler).complete(azure_spec, "What is 2+2?", None, 0.0, 100)

    assert response.status == CallStatus.ok
    assert response.completion_outcome == CompletionOutcome.normal
    assert response.output_text == "The final answer is 4."
    assert "think" not in response.output_text
    assert response.reasoning_tokens == 40
    assert response.input_tokens == 12
    assert response.output_tokens == 6
    assert response.tokens_estimated is False


async def test_token_buckets_are_disjoint_and_sum_to_provider_totals(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "hi", "reasoning_content": "..."}, "finish_reason": "stop"}],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 46,
                    "prompt_tokens_details": {"cached_tokens": 80},
                    "completion_tokens_details": {"reasoning_tokens": 40},
                },
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 100)

    assert response.input_tokens == 20
    assert response.cached_tokens == 80
    assert response.output_tokens == 6
    assert response.reasoning_tokens == 40
    assert response.input_tokens + response.cached_tokens == 100
    assert response.output_tokens + response.reasoning_tokens == 46


async def test_usage_mapping_splits_cached_out_of_input_tokens(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "hello"}, "finish_reason": "stop"}],
                "usage": {
                    "prompt_tokens": 100,
                    "completion_tokens": 10,
                    "prompt_tokens_details": {"cached_tokens": 80},
                },
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", "be nice", 0.5, 50)

    assert response.status == CallStatus.ok
    assert response.input_tokens == 20
    assert response.cached_tokens == 80
    assert response.output_tokens == 10
    assert response.reasoning_tokens == 0
    assert response.tokens_estimated is False


async def test_truncated_response_is_ok_with_truncated_outcome_and_real_tokens(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "partial ans"}, "finish_reason": "length"}],
                "usage": {"prompt_tokens": 5, "completion_tokens": 16},
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 16)

    assert response.status == CallStatus.ok
    assert response.completion_outcome == CompletionOutcome.truncated
    assert response.output_text == "partial ans"
    assert response.input_tokens == 5
    assert response.output_tokens == 16


async def test_content_filtered_response_is_ok_with_filtered_outcome(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": None}, "finish_reason": "content_filter"}],
                "usage": {"prompt_tokens": 7, "completion_tokens": 0},
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 16)

    assert response.status == CallStatus.ok
    assert response.completion_outcome == CompletionOutcome.content_filtered
    assert response.output_text == ""
    assert response.input_tokens == 7


async def test_unknown_finish_reason_maps_to_other_outcome(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "x"}, "finish_reason": "tool_calls"}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 1},
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 16)

    assert response.status == CallStatus.ok
    assert response.completion_outcome == CompletionOutcome.other


async def test_no_usage_object_falls_back_to_estimated_tokens(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "a short reply"}}]})

    response = await _client(handler).complete(azure_spec, "a reasonably long prompt here", None, 0.0, 100)

    assert response.status == CallStatus.ok
    assert response.tokens_estimated is True
    assert response.input_tokens > 0
    assert response.output_tokens > 0


async def test_http_429_returns_failed_response_without_raising(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, json={"error": {"message": "rate limited"}})

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.status == CallStatus.failed
    assert response.completion_outcome is None
    assert response.error_message is not None
    assert "429" in response.error_message
    assert response.attempts == 1


async def test_timeout_returns_failed_response_without_raising(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.status == CallStatus.failed
    assert "timed out" in response.error_message
    assert response.latency_ms >= 0


async def test_missing_api_key_fails_without_any_network_call(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no network call should happen without an API key")

    response = await _client(handler, api_key=None).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.status == CallStatus.failed
    assert "azure_ai_foundry" in response.error_message
    assert "key" in response.error_message.lower()


async def test_malformed_response_returns_failed_response(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"unexpected": "shape"})

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.status == CallStatus.failed
    assert "Malformed response" in response.error_message


async def test_2xx_non_json_body_is_a_failure_not_a_raise(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"<html>gateway error</html>", headers={"content-type": "text/html"})

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.status == CallStatus.failed
    assert "Malformed response" in response.error_message


def _capturing_handler(captured: list[httpx.Request]):
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "hi"}, "finish_reason": "stop"}], "usage": {}})

    return handler


async def test_default_uses_bearer_auth_and_max_tokens(azure_spec) -> None:
    captured: list[httpx.Request] = []
    await _client(_capturing_handler(captured)).complete(azure_spec, "hi", None, 0.0, 50)

    request = captured[0]
    body = json.loads(request.content)
    assert request.headers["authorization"] == "Bearer test-key"
    assert "api-key" not in request.headers
    assert body["max_tokens"] == 50
    assert "max_completion_tokens" not in body


async def test_api_key_header_auth_scheme_is_sent_without_bearer() -> None:
    captured: list[httpx.Request] = []
    client = OpenAICompatibleClient(
        base_url="https://example-azure.test/openai/v1",
        api_key="azure-key",
        auth_scheme=AuthScheme.api_key_header,
        transport=httpx.MockTransport(_capturing_handler(captured)),
    )

    await client.complete(make_spec("azure_ai_foundry", "gpt-4.1"), "hi", None, 0.0, 50)

    assert captured[0].headers["api-key"] == "azure-key"
    assert "authorization" not in captured[0].headers


async def test_spec_selects_max_completion_tokens_over_max_tokens() -> None:
    captured: list[httpx.Request] = []
    spec = make_spec("azure_ai_foundry", "gpt-6.1-sol", uses_max_completion_tokens=True)

    await _client(_capturing_handler(captured)).complete(spec, "hi", None, 0.0, 50)

    body = json.loads(captured[0].content)
    assert body["max_completion_tokens"] == 50
    assert "max_tokens" not in body


async def test_temperature_is_omitted_for_all_models() -> None:
    captured: list[httpx.Request] = []
    for accepts_custom_temperature in (True, False):
        spec = make_spec("azure_ai_foundry", "test-model", accepts_custom_temperature=accepts_custom_temperature)
        await _client(_capturing_handler(captured)).complete(spec, "hi", None, 0.7, 50)
    assert all("temperature" not in json.loads(request.content) for request in captured)


async def test_response_format_is_sent_only_when_the_spec_sets_it() -> None:
    captured: list[httpx.Request] = []
    spec = make_spec("azure_ai_foundry", "Llama-3.3-70B-Instruct", response_format="json_object")

    await _client(_capturing_handler(captured)).complete(spec, "hi", None, 0.0, 50)
    await _client(_capturing_handler(captured)).complete(make_spec("azure_ai_foundry", "gpt-4.1"), "hi", None, 0.0, 50)

    assert json.loads(captured[0].content)["response_format"] == {"type": "json_object"}
    assert "response_format" not in json.loads(captured[1].content)


async def test_reasoning_effort_sent_only_when_reasoning_level_is_set() -> None:
    captured: list[httpx.Request] = []

    await _client(_capturing_handler(captured)).complete(
        make_spec("azure_ai_foundry", "gpt-oss-120b", reasoning_level="low"), "hi", None, 0.0, 50
    )
    await _client(_capturing_handler(captured)).complete(
        make_spec("azure_ai_foundry", "gpt-4.1"), "hi", None, 0.0, 50
    )

    assert json.loads(captured[0].content)["reasoning_effort"] == "low"
    assert "reasoning_effort" not in json.loads(captured[1].content)


async def test_content_filter_results_mark_choice_content_filtered(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [
                    {
                        "message": {"content": ""},
                        "finish_reason": "stop",
                        "content_filter_results": {"hate": {"filtered": True, "severity": "high"}},
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 0},
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.status == CallStatus.ok
    assert response.completion_outcome == CompletionOutcome.content_filtered


async def test_prompt_filter_results_mark_content_filtered(azure_spec) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
                "prompt_filter_results": [
                    {"prompt_index": 0, "content_filter_results": {"self_harm": {"filtered": True, "severity": "medium"}}}
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 1},
            },
        )

    response = await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert response.completion_outcome == CompletionOutcome.content_filtered


async def test_per_model_request_timeout_is_applied_to_the_http_client() -> None:
    spec = make_spec("azure_ai_foundry", "gpt-4.1", request_timeout_seconds=45.0)
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {}})

    await _client(handler).complete(spec, "hi", None, 0.0, 50)

    assert captured[0].extensions["timeout"]["read"] == 45.0


async def test_request_timeout_falls_back_when_spec_omits_it(azure_spec) -> None:
    assert azure_spec.request_timeout_seconds is None
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}], "usage": {}})

    await _client(handler).complete(azure_spec, "hi", None, 0.0, 50)

    assert captured[0].extensions["timeout"]["read"] == DEFAULT_REQUEST_TIMEOUT_SECONDS
