"""The judge: scores one answer, or compares two with the order swapped.

Provider requests use their default temperature. On an invalid reply the judge
retries once naming the fault, then records a failed judgment rather than
fabricating a score.
"""

from collections.abc import Callable
from typing import TypeVar

from evaluation.contracts import CallStatus, ModelClient, ModelResponse, ModelSpec
from evaluation.judging.parsing import parse_pairwise_verdict, parse_scoring_verdict
from evaluation.judging.prompt import render_pairwise_prompt, render_scoring_prompt
from evaluation.judging.rubric import Rubric
from evaluation.judging.verdict import (
    Judgment,
    JudgmentStatus,
    PairwiseChoice,
    PairwiseJudgment,
    PairwiseVerdict,
)

_JUDGE_TEMPERATURE = 0.0
_DEFAULT_MAX_OUTPUT_TOKENS = 1024

_Parsed = TypeVar("_Parsed")


class Judge:
    """Scores support answers against a rubric with an explicitly configured judge."""

    def __init__(
        self,
        client: ModelClient,
        judge_spec: ModelSpec,
        rubric: Rubric,
        max_output_tokens: int = _DEFAULT_MAX_OUTPUT_TOKENS,
    ) -> None:
        self._client = client
        self._judge_spec = judge_spec
        self._rubric = rubric
        self._max_output_tokens = max_output_tokens

    async def score(self, policy: str, question: str, reference: str, candidate: str) -> Judgment:
        """Score one candidate answer and compute its weighted total in Python."""
        system, user = render_scoring_prompt(self._rubric, policy, question, reference, candidate)
        verdict, attempts, error = await self._call_with_one_retry(
            system, user, lambda text: parse_scoring_verdict(text, self._rubric)
        )
        if verdict is None:
            return self._failed(attempts, error)
        scores = {name: criterion.score for name, criterion in verdict.scores.items()}
        return Judgment(
            status=JudgmentStatus.ok,
            verdict=verdict,
            weighted_total=self._rubric.weighted_total(scores),
            rubric_name=self._rubric.name,
            rubric_version=self._rubric.version,
            attempts=attempts,
        )

    async def compare_pair(
        self, policy: str, question: str, reference: str, answer_a: str, answer_b: str
    ) -> PairwiseJudgment:
        """Compare two answers twice, with A and B swapped, and report whether the winner survives the swap."""
        original, _, error_first = await self._pairwise(policy, question, reference, answer_a, answer_b)
        swapped, _, error_second = await self._pairwise(policy, question, reference, answer_b, answer_a)
        if original is None or swapped is None:
            return PairwiseJudgment(status=JudgmentStatus.failed, error_message=error_first or error_second)
        survives, bias = _swap_consistency(original.overall, swapped.overall)
        return PairwiseJudgment(
            status=JudgmentStatus.ok,
            original=original,
            swapped=swapped,
            verdict_survives_swap=survives,
            shows_position_bias=bias,
        )

    async def _pairwise(
        self, policy: str, question: str, reference: str, answer_a: str, answer_b: str
    ) -> tuple[PairwiseVerdict | None, int, str | None]:
        system, user = render_pairwise_prompt(self._rubric, policy, question, reference, answer_a, answer_b)
        return await self._call_with_one_retry(system, user, parse_pairwise_verdict)

    async def _call_with_one_retry(
        self,
        system: str,
        user: str,
        parser: Callable[[str], tuple[_Parsed | None, str | None]],
    ) -> tuple[_Parsed | None, int, str | None]:
        response = await self._complete(user, system)
        if response.status is not CallStatus.ok:
            return None, 1, f"judge call failed: {response.error_message}"
        parsed, fault = parser(response.output_text)
        if parsed is not None:
            return parsed, 1, None

        correction = f"{user}\n\nYour previous reply was invalid: {fault} Reply with only the corrected JSON."
        retry = await self._complete(correction, system)
        if retry.status is not CallStatus.ok:
            return None, 2, f"judge call failed on retry: {retry.error_message}"
        parsed_retry, fault_retry = parser(retry.output_text)
        return parsed_retry, 2, fault_retry

    async def _complete(self, user: str, system: str) -> ModelResponse:
        return await self._client.complete(self._judge_spec, user, system, _JUDGE_TEMPERATURE, self._max_output_tokens)

    def _failed(self, attempts: int, error: str | None) -> Judgment:
        return Judgment(
            status=JudgmentStatus.failed,
            rubric_name=self._rubric.name,
            rubric_version=self._rubric.version,
            attempts=attempts,
            error_message=error,
        )


def _swap_consistency(first: PairwiseChoice, swapped: PairwiseChoice) -> tuple[bool, bool]:
    first_pick = {PairwiseChoice.a: "answer_a", PairwiseChoice.b: "answer_b", PairwiseChoice.tie: "tie"}[first]
    swapped_pick = {PairwiseChoice.a: "answer_b", PairwiseChoice.b: "answer_a", PairwiseChoice.tie: "tie"}[swapped]
    survives = first_pick == swapped_pick
    shows_position_bias = first is not PairwiseChoice.tie and first is swapped
    return survives, shows_position_bias
