"""Run-setup guards for the judge, enforced in code rather than by convention."""

from collections.abc import Iterable

from evaluation.contracts import ModelSpec


def ensure_temperature_pinnable(judge_spec: ModelSpec) -> None:
    """Check whether a model supports explicitly setting temperature 0."""
    if not judge_spec.accepts_custom_temperature:
        raise ValueError(
            f"Judge '{judge_spec.model_name}' cannot be pinned to temperature 0 "
            "(accepts_custom_temperature is False); its scores would not be reproducible."
        )


def ensure_judge_not_judged(judge_spec: ModelSpec, judged_specs: Iterable[ModelSpec]) -> None:
    """A model may not judge a run it is being compared in."""
    judged = {spec.model_name for spec in judged_specs}
    if judge_spec.model_name in judged:
        raise ValueError(f"Judge '{judge_spec.model_name}' is also being judged in this run; choose a different judge.")
