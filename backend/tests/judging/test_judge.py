from decimal import Decimal

import pytest

from evaluation.contracts import CallStatus
from evaluation.judging.guards import ensure_judge_not_judged
from evaluation.judging.judge import Judge
from evaluation.judging.rubric import default_support_rubric
from evaluation.judging.verdict import JudgmentStatus
from tests.judging.conftest import StubJudgeClient, make_judge_spec, scoring_json

_RUBRIC = default_support_rubric()


def _judge(outputs, **kwargs):
    client = StubJudgeClient(outputs, **kwargs)
    return Judge(client, make_judge_spec(), _RUBRIC), client


async def _score(judge):
    return await judge.score(policy="P", question="Q", reference="R", candidate="C")


async def test_valid_verdict_is_parsed_and_total_computed() -> None:
    judge, client = _judge([scoring_json(5, 4, 3, 2)])

    judgment = await _score(judge)

    assert judgment.status is JudgmentStatus.ok
    assert judgment.weighted_total == Decimal("3.90")
    assert judgment.verdict.scores["honesty"].score == 3
    assert judgment.attempts == 1
    assert client.calls[0]["temperature"] == 0.0


async def test_invalid_json_is_retried_once_then_recovers() -> None:
    judge, client = _judge(["not json at all", scoring_json(4, 4, 4, 4)])

    judgment = await _score(judge)

    assert judgment.status is JudgmentStatus.ok
    assert judgment.attempts == 2
    assert len(client.calls) == 2
    assert "was invalid" in client.calls[1]["prompt"]


async def test_invalid_json_twice_is_recorded_as_failed_not_guessed() -> None:
    judge, client = _judge(["nope", "still nope"])

    judgment = await _score(judge)

    assert judgment.status is JudgmentStatus.failed
    assert judgment.verdict is None
    assert judgment.weighted_total is None
    assert judgment.attempts == 2
    assert judgment.error_message is not None


async def test_schema_mismatch_names_the_fault_in_the_retry() -> None:
    wrong_criteria = '{"speed": {"score": 5, "rationale": "r"}, "overall_note": "x"}'
    judge, client = _judge([wrong_criteria, scoring_json(3, 3, 3, 3)])

    await _score(judge)

    assert "criterion" in client.calls[1]["prompt"]


async def test_transport_failure_is_not_retried_for_json() -> None:
    judge, client = _judge(["irrelevant"], status=CallStatus.failed, error_message="azure returned HTTP 503")

    judgment = await _score(judge)

    assert judgment.status is JudgmentStatus.failed
    assert judgment.attempts == 1
    assert len(client.calls) == 1


def test_judge_accepts_a_model_that_cannot_be_pinned_to_temperature_zero() -> None:
    spec = make_judge_spec(accepts_custom_temperature=False)

    Judge(StubJudgeClient([]), spec, _RUBRIC)


def test_judge_may_not_be_one_of_the_judged_models() -> None:
    judge_spec = make_judge_spec(name="Llama-3.3-70B-Instruct")
    judged = [make_judge_spec(name="gpt-4.1"), make_judge_spec(name="Llama-3.3-70B-Instruct")]

    with pytest.raises(ValueError):
        ensure_judge_not_judged(judge_spec, judged)

    ensure_judge_not_judged(judge_spec, [make_judge_spec(name="gpt-4.1")])
