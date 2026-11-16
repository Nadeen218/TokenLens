from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import arq
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.redis_config import redis_settings_from_url
from app.models.entities import (
    Dataset,
    DatasetItem,
    Judgment,
    Model,
    Result,
    Rubric,
    Run,
    RunModel,
    RunStatus,
)
from app.services.rubric_service import freeze_rubric, validate_rubric_values


class RunValidationError(Exception):
    pass


@dataclass
class RunWithModels:
    run: Run
    model_ids: list[uuid.UUID]


_redis_pool: Any = None


async def _get_redis_pool() -> Any:
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = await arq.create_pool(redis_settings_from_url(settings.redis_url))
    return _redis_pool


async def create_run(
    session: AsyncSession,
    user_id: uuid.UUID,
    name: str,
    dataset_id: uuid.UUID,
    rubric_id: uuid.UUID,
    model_ids: list[uuid.UUID],
    judge_model_id: uuid.UUID,
    repeats: int,
    temperature: float,
    swap_order: bool,
) -> RunWithModels:
    dataset = await session.scalar(select(Dataset).where(Dataset.id == dataset_id, Dataset.owner_id == user_id))
    if dataset is None:
        raise RunValidationError("Dataset not found.")

    item_count = (
        await session.scalar(select(func.count()).select_from(DatasetItem).where(DatasetItem.dataset_id == dataset_id))
        or 0
    )
    if item_count < 1:
        raise RunValidationError("Dataset must contain at least one question.")

    rubric = await session.scalar(select(Rubric).where(Rubric.id == rubric_id, Rubric.owner_id == user_id))
    if rubric is None:
        raise RunValidationError("Rubric not found.")

    validate_rubric_values(rubric.criteria, rubric.scale_min, rubric.scale_max)

    selected_models = (
        await session.scalars(
            select(Model).where(Model.id.in_(model_ids), Model.is_active.is_(True))
        )
    ).all()
    if len(selected_models) != len(model_ids):
        raise RunValidationError("All selected models must exist and be active.")

    judge_model = await session.scalar(
        select(Model).where(Model.id == judge_model_id, Model.is_active.is_(True))
    )
    if judge_model is None:
        raise RunValidationError("Judge model must exist and be active.")

    run = Run(
        user_id=user_id,
        dataset_id=dataset_id,
        rubric_id=rubric_id,
        baseline_run_id=None,
        judge_model_id=judge_model_id,
        name=name.strip(),
        repeats=repeats,
        temperature=Decimal(str(temperature)),
        swap_order=swap_order,
        status=RunStatus.QUEUED,
        total_cost_usd=Decimal("0"),
        finished_at=None,
    )
    session.add(run)
    await session.flush()

    for model_id in model_ids:
        session.add(RunModel(run_id=run.id, model_id=model_id))

    try:
        await session.commit()
    except Exception:
        await session.rollback()
        raise

    await session.refresh(run)
    await freeze_rubric(session, rubric_id)

    pool = await _get_redis_pool()
    await pool.enqueue_job("run_evaluation", str(run.id))

    return RunWithModels(run=run, model_ids=model_ids)


async def list_user_runs(
    session: AsyncSession,
    user_id: uuid.UUID,
    page: int,
    size: int,
) -> tuple[list[RunWithModels], int]:
    total = await session.scalar(select(func.count()).select_from(Run).where(Run.user_id == user_id)) or 0
    offset = (page - 1) * size
    runs = (
        await session.scalars(
            select(Run)
            .where(Run.user_id == user_id)
            .order_by(Run.created_at.desc())
            .offset(offset)
            .limit(size)
        )
    ).all()
    run_with_models = await _attach_model_ids(session, list(runs))
    return run_with_models, total


async def get_user_run(session: AsyncSession, user_id: uuid.UUID, run_id: uuid.UUID) -> RunWithModels | None:
    run = await session.scalar(select(Run).where(Run.user_id == user_id, Run.id == run_id))
    if run is None:
        return None
    row = await _attach_model_ids(session, [run])
    return row[0]


async def list_run_results(
    session: AsyncSession,
    run_id: uuid.UUID,
    page: int,
    size: int,
):
    total = await session.scalar(select(func.count()).select_from(Result).where(Result.run_id == run_id)) or 0
    offset = (page - 1) * size

    rows = (
        await session.execute(
            select(Result, DatasetItem.position, DatasetItem.input_prompt, Model.display_name)
            .join(DatasetItem, DatasetItem.id == Result.item_id)
            .join(Model, Model.id == Result.model_id)
            .where(Result.run_id == run_id)
            .order_by(DatasetItem.position.asc(), Result.model_id.asc(), Result.repeat_index.asc())
            .offset(offset)
            .limit(size)
        )
    ).all()

    result_ids = [row[0].id for row in rows]
    judgments_map: dict[uuid.UUID, list[Judgment]] = {result_id: [] for result_id in result_ids}
    if result_ids:
        judgments = (
            await session.scalars(
                select(Judgment)
                .where(Judgment.result_id.in_(result_ids))
                .order_by(Judgment.result_id.asc(), Judgment.created_at.asc())
            )
        ).all()
        for judgment in judgments:
            judgments_map[judgment.result_id].append(judgment)

    return rows, judgments_map, total


async def _attach_model_ids(session: AsyncSession, runs: list[Run]) -> list[RunWithModels]:
    if not runs:
        return []
    run_ids = [run.id for run in runs]
    rows = (
        await session.execute(
            select(RunModel.run_id, RunModel.model_id)
            .where(RunModel.run_id.in_(run_ids))
            .order_by(RunModel.run_id.asc())
        )
    ).all()
    mapping: dict[uuid.UUID, list[uuid.UUID]] = {run_id: [] for run_id in run_ids}
    for run_id, model_id in rows:
        mapping[run_id].append(model_id)

    return [RunWithModels(run=run, model_ids=mapping.get(run.id, [])) for run in runs]
