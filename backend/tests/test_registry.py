import asyncio
import json
from decimal import Decimal

import httpx

from evaluation.judging.judge import Judge
from evaluation.judging.rubric import default_support_rubric
from evaluation.judging.verdict import JudgmentStatus
from evaluation.providers.google_ai_studio import GoogleAIStudioClient
from evaluation.providers.openai_compatible import OpenAICompatibleClient
from evaluation.registry import get_all_specs, get_compared_models, get_default_judge, get_model_by_name, list_judge_models
from tests.judging.conftest import scoring_json


def test_no_compared_model_is_judge_eligible() -> None:
    assert all(not model.is_judge_eligible for model in get_compared_models())


def test_judges_and_compared_models_are_disjoint() -> None:
    compared = {model.model_name for model in get_compared_models()}
    judges = {model.model_name for model in list_judge_models()}

    assert compared.isdisjoint(judges)


def test_judges_are_listed_and_eligible() -> None:
    providers = {model.provider for model in list_judge_models()}

    assert providers == {"azure_ai_foundry", "google_ai_studio"}
    assert all(model.is_judge_eligible for model in list_judge_models())


def test_gpt_6_astra_is_registered_as_an_azure_judge() -> None:
    spec = get_model_by_name("gpt-6-astra")

    assert spec in list_judge_models()
    assert spec.provider == "azure_ai_foundry"
    assert spec.uses_max_completion_tokens
    assert not spec.accepts_custom_temperature
    assert spec.input_price_per_mtok == Decimal("1.00")
    assert spec.output_price_per_mtok == Decimal("3.00")


def test_azure_judges_omit_temperature_from_requests() -> None:
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": scoring_json(5, 4, 3, 2)}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 20},
            },
        )

    client = OpenAICompatibleClient(
        base_url="https://example-provider.test/v1",
        api_key="test-key",
        transport=httpx.MockTransport(handler),
    )
    specs = [spec for spec in get_all_specs() if spec.provider == "azure_ai_foundry"]
    for spec in specs:
        judge = Judge(client, spec, default_support_rubric())
        result = asyncio.run(judge.score("P", "Q", "R", "C"))
        assert result.status is JudgmentStatus.ok

    assert len(requests) == len(specs)
    for spec, request in zip(specs, requests):
        assert request["model"] == spec.model_name
        assert "temperature" not in request
        token_param = "max_completion_tokens" if spec.uses_max_completion_tokens else "max_tokens"
        assert request[token_param] == 1024


def test_google_judge_omits_temperature_from_request() -> None:
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "steps": [{"type": "model_output", "content": [{"type": "text", "text": scoring_json(5, 4, 3, 2)}]}],
            },
        )

    client = GoogleAIStudioClient(api_key="test-key", transport=httpx.MockTransport(handler))
    judge = Judge(client, get_model_by_name("gemini-3.8-flash"), default_support_rubric())
    result = asyncio.run(judge.score("P", "Q", "R", "C"))

    assert result.status is JudgmentStatus.ok
    assert len(requests) == 1
    assert "temperature" not in requests[0]
    assert "temperature" not in requests[0]["generation_config"]


def test_default_judge_is_azure_and_itself_eligible() -> None:
    default = get_default_judge()

    assert default.provider == "azure_ai_foundry"
    assert default.model_name == "Llama-3.3-70B-Instruct"
    assert default in list_judge_models()
