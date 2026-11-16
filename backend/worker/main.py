"""ARQ worker entrypoint that runs evaluation jobs enqueued by the API."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
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
_CONCURRENCY = 2 # Limit concurrent tasks to 2.


@dataclass
class RunContext:
    run: Run
    dataset: Dataset
    items: list[DatasetItem]
    model_rows: list[Model]
    judge_model_row: Model
    rubric_row: Rubric


@dataclass
class _Job:
    model_id: uuid.UUID
    spec: ModelSpec
    item_id: uuid.UUID
    prompt: str
    expected: str
    repeat_index: int


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


async def _judge_calls(
    client: ModelClient,
    judge_spec: ModelSpec,
    rubric: EvaluationRubric,
    policy: str,
    question: str,
    reference: str,
    answer: str,
    swap_order: bool,
) -> list[tuple[int, object, Decimal]]:
    """Judge calls only (network, no DB access).

    Scores once, or twice as order_variant 0/1 when swap_order is set. Judge.score()
    takes a single answer, so the second call measures judge noise (repeat-scoring
    variance), not position bias.

    A fresh UsageRecorder per job keeps judge cost correct when jobs run concurrently.
    """
    recorder = UsageRecorder(client)
    judge = Judge(recorder, judge_spec, rubric)
    calls: list[tuple[int, object, Decimal]] = []
    for order_variant in range(2 if swap_order else 1):
        cost_before = recorder.total_cost
        judgment = await judge.score(policy, question, reference, answer)
        calls.append((order_variant, judgment, recorder.total_cost - cost_before))
    return calls


def _add_judgments(session, judge_model_id: uuid.UUID, result_id: uuid.UUID, calls) -> None:
    for order_variant, judgment, judge_cost in calls:
        if not judgment.verdict:
            print("JUDGE FAILED:", judgment.error_message, flush=True)
        criteria_scores = (
            {name: verdict.score for name, verdict in judgment.verdict.scores.items()} if judgment.verdict else {}
        )
        reasoning = judgment.verdict.overall_note if judgment.verdict else (judgment.error_message or "")
        session.add(
            Judgment(
                result_id=result_id,
                judge_model_id=judge_model_id,
                order_variant=order_variant,
                score=judgment.weighted_total or Decimal("0"),
                criteria_scores=criteria_scores,
                reasoning=reasoning,
                judge_cost_usd=judge_cost,
            )
        )


async def _run_models(session, context: RunContext) -> Decimal:
    client = _build_client()
    judge_spec = get_model_by_name(context.judge_model_row.model_name)
    specs: dict[uuid.UUID, ModelSpec] = {row.id: get_model_by_name(row.model_name) for row in context.model_rows}
    ensure_judge_not_judged(judge_spec, specs.values())

    rubric = _build_rubric(context.rubric_row)
    policy = context.dataset.description or ""

    # Copy plain values now: ORM objects expire after each commit.
    temperature = float(context.run.temperature)
    swap_order = context.run.swap_order
    run_id = context.run.id
    judge_model_id = context.judge_model_row.id

    jobs = [
        _Job(row.id, specs[row.id], item.id, item.input_prompt, item.expected_output or "", repeat_index)
        for row in context.model_rows
        for item in context.items
        for repeat_index in range(context.run.repeats)
    ]

    sem = asyncio.Semaphore(_CONCURRENCY)
    db_lock = asyncio.Lock()  # AsyncSession is not safe for concurrent use
    total_cost = Decimal("0")

    async def process(job: _Job) -> None:
        nonlocal total_cost
        async with sem:
            response = await client.complete(job.spec, job.prompt, policy, temperature, _CANDIDATE_MAX_TOKENS)
            calls: list = []
            if response.status is CallStatus.ok:
                calls = await _judge_calls(
                    client,
                    judge_spec,
                    rubric,
                    policy,
                    job.prompt,
                    job.expected,
                    response.output_text,
                    swap_order,
                )

        fields = _result_fields(response)
        async with db_lock:  # one DB writer at a time
            result = Result(
                run_id=run_id,
                item_id=job.item_id,
                model_id=job.model_id,
                repeat_index=job.repeat_index,
                **fields,
            )
            session.add(result)
            await session.flush()
            _add_judgments(session, judge_model_id, result.id, calls)
            await session.commit()  # progress is visible right away in the UI
            total_cost += fields["cost_usd"]

    tasks = [asyncio.create_task(process(job)) for job in jobs]
    try:
        await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

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
            run = await session.get(Run, uuid.UUID(run_id))
            run.status = RunStatus.COMPLETED
            run.total_cost_usd = total_cost
            run.finished_at = datetime.now(timezone.utc)
            await session.commit()
        except Exception as exc:
            await session.rollback()
            run = await session.get(Run, uuid.UUID(run_id))
            run.status = RunStatus.FAILED
            run.error_message = str(exc)
            run.finished_at = datetime.now(timezone.utc)
            await session.commit()
            raise


class WorkerSettings:
    functions = [run_evaluation]
    redis_settings = redis_settings_from_url(settings.redis_url)
    max_jobs = 10
    job_timeout = 3600