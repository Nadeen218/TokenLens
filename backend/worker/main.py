"""ARQ worker entrypoint that runs evaluation jobs enqueued by the API."""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy import select

import app.dbconfig as dbconfig
from app.config import settings
from app.redis_config import redis_settings_from_url
from app.models.entities import (
    Dataset,
    DatasetItem,
    Judgment,
    Model,
    Result,
    ResultStatus,
    Rubric,
    Run,
    RunModel,
    RunStatus,
)
from evaluation.contracts import CallStatus, ModelClient, ModelResponse, ModelSpec
from evaluation.cost import compute_call_cost
from evaluation.execution import InMemoryCache, ProviderConcurrency, RetryPolicy, build_execution_client
from evaluation.judging.guards import ensure_judge_not_judged
from evaluation.judging.judge import Judge
from evaluation.judging.rubric import Criterion
from evaluation.judging.rubric import Rubric as EvaluationRubric
from evaluation.execution.caching_client import CacheStats
from evaluation.measurement.usage import UsageRecorder
from evaluation.providers.resolver import resolve_client
from evaluation.registry import get_model_by_name

_CANDIDATE_MAX_TOKENS = 512


@dataclass
class RunContext:
    run: Run
    dataset: Dataset
    items: list[DatasetItem]
    model_rows: list[Model]
    judge_model_row: Model
    rubric_row: Rubric


async def _load_run_context(session, run: Run) -> RunContext:
    dataset = await session.get(Dataset, run.dataset_id)
    model_ids = (await session.scalars(select(RunModel.model_id).where(RunModel.run_id == run.id))).all()
    model_rows = (await session.scalars(select(Model).where(Model.id.in_(model_ids)))).all()
    judge_model_row = await session.get(Model, run.judge_model_id)
    items = (
        await session.scalars(
            select(DatasetItem).where(DatasetItem.dataset_id == run.dataset_id).order_by(DatasetItem.position)
        )
    ).all()
    rubric_row = await session.get(Rubric, run.rubric_id)
    return RunContext(
        run=run,
        dataset=dataset,
        items=list(items),
        model_rows=list(model_rows),
        judge_model_row=judge_model_row,
        rubric_row=rubric_row,
    )


def _build_rubric(rubric_row: Rubric) -> EvaluationRubric:
    criteria = tuple(Criterion(**entry) for entry in rubric_row.criteria)
    return EvaluationRubric(
        name=rubric_row.name, version=rubric_row.version, is_frozen=rubric_row.is_frozen, criteria=criteria
    )


def _build_client() -> ModelClient:
    execution = build_execution_client(
        resolve=lambda spec: resolve_client(
            spec, google_api_key=settings.google_api_key, azure_api_key=settings.azure_api_key
        ),
        concurrency=ProviderConcurrency(),
        cache_backend=InMemoryCache(),
        cache_stats=CacheStats(),
        retry_policy=RetryPolicy(),
    )
    return execution.select(use_cache=False)


def _result_fields(response: ModelResponse) -> dict:
    snapshot = response.prices_snapshot
    return {
        "output_text": response.output_text,
        "input_tokens": response.input_tokens,
        "output_tokens": response.output_tokens,
        "cached_tokens": response.cached_tokens,
        "reasoning_tokens": response.reasoning_tokens,
        "latency_ms": response.latency_ms,
        "cost_usd": compute_call_cost(response).total_cost,
        "input_price_per_mtok": snapshot.input_price_per_mtok,
        "output_price_per_mtok": snapshot.output_price_per_mtok,
        "cached_input_price_per_mtok": snapshot.cached_input_price_per_mtok,
        "status": ResultStatus.OK if response.status is CallStatus.ok else ResultStatus.FAILED,
        "completion_outcome": response.completion_outcome.value if response.completion_outcome else None,
        "tokens_estimated": response.tokens_estimated,
        "error_message": response.error_message,
        "attempts": response.attempts,
    }


async def _score_result(
    session,
    judge: Judge,
    judge_recorder: UsageRecorder,
    judge_model_id: uuid.UUID,
    result: Result,
    swap_order: bool,
    policy: str,
    question: str,
    reference: str,
) -> None:
    """Score result once, or twice as order_variant 0/1 when swap_order is set.

    Judge.score() takes a single answer; there is no position to swap, so the
    second call measures judge noise (repeat-scoring variance), not position bias.
    """
    for order_variant in range(2 if swap_order else 1):
        cost_before = judge_recorder.total_cost
        judgment = await judge.score(policy, question, reference, result.output_text)
        judge_cost = judge_recorder.total_cost - cost_before
        criteria_scores = (
            {name: verdict.score for name, verdict in judgment.verdict.scores.items()} if judgment.verdict else {}
        )
        reasoning = judgment.verdict.overall_note if judgment.verdict else (judgment.error_message or "")
        session.add(
            Judgment(
                result_id=result.id,
                judge_model_id=judge_model_id,
                order_variant=order_variant,
                score=judgment.weighted_total or Decimal("0"),
                criteria_scores=criteria_scores,
                reasoning=reasoning,
                judge_cost_usd=judge_cost,
            )
        )


async def _generate_and_persist_result(
    session, client: ModelClient, spec: ModelSpec, run: Run, model_row: Model, item: DatasetItem, repeat_index: int, policy: str
) -> Result:
    response = await client.complete(spec, item.input_prompt, policy, float(run.temperature), _CANDIDATE_MAX_TOKENS)
    result = Result(
        run_id=run.id,
        item_id=item.id,
        model_id=model_row.id,
        repeat_index=repeat_index,
        **_result_fields(response),
    )
    session.add(result)
    await session.flush()
    return result


async def _run_models(session, context: RunContext) -> Decimal:
    client = _build_client()
    judge_recorder = UsageRecorder(client)
    judge_spec = get_model_by_name(context.judge_model_row.model_name)
    specs: dict[uuid.UUID, ModelSpec] = {row.id: get_model_by_name(row.model_name) for row in context.model_rows}
    ensure_judge_not_judged(judge_spec, specs.values())

    judge = Judge(judge_recorder, judge_spec, _build_rubric(context.rubric_row))
    policy = context.dataset.description or ""
    total_cost = Decimal("0")

    for model_row in context.model_rows:
        spec = specs[model_row.id]
        for item in context.items:
            for repeat_index in range(context.run.repeats):
                result = await _generate_and_persist_result(
                    session, client, spec, context.run, model_row, item, repeat_index, policy
                )
                total_cost += result.cost_usd
                if result.status is ResultStatus.OK:
                    await _score_result(
                        session,
                        judge,
                        judge_recorder,
                        context.judge_model_row.id,
                        result,
                        context.run.swap_order,
                        policy,
                        item.input_prompt,
                        item.expected_output or "",
                    )

    return total_cost


async def run_evaluation(ctx: dict, run_id: str) -> None:
    dbconfig._ensure_session_factory()
    async with dbconfig.SessionLocal() as session:
        run = await session.get(Run, uuid.UUID(run_id))
        if run is None:
            raise ValueError(f"Run {run_id} not found.")

        run.status = RunStatus.RUNNING
        await session.commit()

        try:
            context = await _load_run_context(session, run)
            total_cost = await _run_models(session, context)
            run.status = RunStatus.COMPLETED
            run.total_cost_usd = total_cost
            await session.commit()
        except Exception as exc:
            await session.rollback()
            run = await session.get(Run, uuid.UUID(run_id))
            run.status = RunStatus.FAILED
            run.error_message = str(exc)
            await session.commit()
            raise


class WorkerSettings:
    functions = [run_evaluation]
    redis_settings = redis_settings_from_url(settings.redis_url)
    max_jobs = 10
