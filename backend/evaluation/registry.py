"""Single source of truth for the compared models and the judges.

Every model identifier, price, timeout, and reasoning level lives here;
adding or retuning a model is a row change in this file, nowhere else.

All models but the Gemini judge are deployments on one Azure AI Foundry
endpoint, differing only in deployment name and the parameters each accepts.
Azure prices are Global Standard from Microsoft's Azure Retail Prices API
(prices.azure.com), verified 2026-11-03.
"""

from decimal import Decimal

from evaluation.contracts import ModelSpec

_GPT_OSS_120B = ModelSpec(
    provider="azure_ai_foundry",
    model_name="gpt-oss-120b",
    display_name="GPT-OSS 120B (Azure)",
    context_window=131072,
    input_price_per_mtok=Decimal("0.15"),
    output_price_per_mtok=Decimal("0.60"),
    cached_input_price_per_mtok=None,
    pricing_notes=(
        "Compared, large, OpenAI open-weight family; cheapest here, the low end "
        "of a ~13x input-price spread up to gpt-6.1-sol that gives the "
        "cost-vs-quality axis its range. Microsoft Azure Retail Prices API, "
        "'Azure OpenAI OSS Models', Global Standard; no cached-input meter. "
        "REASONING-TOKEN BLIND SPOT: this Azure deployment returns no "
        "completion_tokens_details, so reasoning_tokens always reads 0 and any "
        "reasoning is folded into completion_tokens. Total cost is unaffected "
        "(reasoning and output share the output rate), but unlike gpt-6.1-sol "
        "the reasoning/output split is unavailable for this model."
    ),
    is_active=True,
    reasoning_level="low",
)

_GPT_41 = ModelSpec(
    provider="azure_ai_foundry",
    model_name="gpt-4.1",
    display_name="GPT-4.1 (Azure)",
    context_window=1_047_576,
    input_price_per_mtok=Decimal("2.00"),
    output_price_per_mtok=Decimal("8.00"),
    cached_input_price_per_mtok=Decimal("0.50"),
    pricing_notes=(
        "Compared, mid, OpenAI family. Microsoft Azure Retail Prices API, "
        "'Azure OpenAI' gpt 4.1, Global Standard. Rejects reasoning_effort "
        "(not a reasoning model), so reasoning_level stays unset."
    ),
    is_active=True,
)

_GPT_61_SOL = ModelSpec(
    provider="azure_ai_foundry",
    model_name="gpt-6.1-sol",
    display_name="GPT-6.1 Sol (Azure)",
    context_window=400000,
    input_price_per_mtok=Decimal("2.00"),
    output_price_per_mtok=Decimal("10.00"),
    cached_input_price_per_mtok=Decimal("0.10"),
    pricing_notes=(
        "Compared, premium, OpenAI family; the high end of the ~13x price "
        "spread. Microsoft Azure Retail Prices API, 'Azure OpenAI GPT6', "
        "short-context Standard Global (long-context tiers cost more). Requires "
        "max_completion_tokens. Uses its default temperature, so results and "
        "judgment scores may vary between runs. Reports reasoning_tokens, "
        "unlike gpt-oss-120b."
    ),
    is_active=True,
    uses_max_completion_tokens=True,
    accepts_custom_temperature=False,
    reasoning_level="low",
)

_LLAMA_33_70B = ModelSpec(
    provider="azure_ai_foundry",
    model_name="Llama-3.3-70B-Instruct",
    display_name="Llama 3.3 70B Instruct (Azure, judge)",
    context_window=128000,
    input_price_per_mtok=Decimal("0.71"),
    output_price_per_mtok=Decimal("0.71"),
    cached_input_price_per_mtok=None,
    pricing_notes=(
        "Default judge. Microsoft Azure Retail Prices API, 'Azure Llama "
        "Models', Global Standard; no cached-input meter. Chosen as judge "
        "because it is from a family unrelated to the compared models (no "
        "same-family bias). Meta family. JSON MODE: this deployment emits "
        "trailing commas without response_format and silently ignores "
        "json_schema (accepted but not enforced, verified by live probe), but "
        "honors json_object — so the judge requests json_object for "
        "structurally valid output and the parser stays strict."
    ),
    is_active=True,
    is_judge_eligible=True,
    request_timeout_seconds=120.0,
    response_format="json_object",
)

_GPT_6_ASTRA = ModelSpec(
    provider="azure_ai_foundry",
    model_name="gpt-6-astra",
    display_name="GPT-6 Astra (Azure, judge)",
    context_window=128000,
    input_price_per_mtok=Decimal("1.00"),
    output_price_per_mtok=Decimal("3.00"),
    cached_input_price_per_mtok=None,
    pricing_notes=(
        "Provisional configuration: input and output prices come from the existing "
        "database record; the context window and request capabilities must be "
        "verified against the Azure deployment. Uses the provider's default "
        "temperature for judging, so scores may vary between runs."
    ),
    is_active=True,
    is_judge_eligible=True,
    uses_max_completion_tokens=True,
    accepts_custom_temperature=False,
)

_GEMINI_JUDGE = ModelSpec(
    provider="google_ai_studio",
    model_name="gemini-3.8-flash",
    display_name="Gemini 3.8 Flash (judge)",
    context_window=1_000_000,
    input_price_per_mtok=Decimal("0.30"),
    output_price_per_mtok=Decimal("2.50"),
    cached_input_price_per_mtok=Decimal("0.075"),
    pricing_notes=(
        "Cross-check judge, from a family unrelated to the compared models, run "
        "alongside the default Llama judge so the same dataset can be scored by "
        "both and the rankings compared. Google's published Gemini API rate "
        "card; free tier roughly 10 RPM, 1500 RPD (community-reported)."
    ),
    is_active=True,
    is_judge_eligible=True,
    # gemini-3.8-flash supports low/medium/high only — it rejects "minimal".
    reasoning_level="low",
    request_timeout_seconds=120.0,
)

_COMPARED_MODELS: tuple[ModelSpec, ...] = (_GPT_OSS_120B, _GPT_41, _GPT_61_SOL)
_JUDGE_MODELS: tuple[ModelSpec, ...] = (_LLAMA_33_70B, _GPT_6_ASTRA, _GEMINI_JUDGE)
_DEFAULT_JUDGE = _LLAMA_33_70B


def get_compared_models() -> list[ModelSpec]:
    """Active models eligible for a comparison run; a judge-eligible model is never one."""
    return [model for model in _COMPARED_MODELS if model.is_active and not model.is_judge_eligible]


def list_judge_models() -> list[ModelSpec]:
    """Active judge-eligible models, so one dataset can be scored by each and the rankings compared."""
    return [model for model in _JUDGE_MODELS if model.is_active and model.is_judge_eligible]


def get_default_judge() -> ModelSpec:
    """The judge used unless a run chooses another."""
    return _DEFAULT_JUDGE


def get_model_by_name(model_name: str) -> ModelSpec:
    """Look up a compared or judge ModelSpec by its registry model_name; raises if none matches."""
    for spec in (*_COMPARED_MODELS, *_JUDGE_MODELS):
        if spec.model_name == model_name:
            return spec
    raise ValueError(f"No registered ModelSpec named '{model_name}'.")


def get_all_specs() -> list[ModelSpec]:
    """Every registered ModelSpec, compared and judge alike."""
    return [*_COMPARED_MODELS, *_JUDGE_MODELS]


async def seed_models(session) -> None:
    """Upsert every registered ModelSpec into the models table, matched on model_name."""
    from sqlalchemy import select

    from app.models.entities import Model

    for spec in get_all_specs():
        existing = await session.scalar(select(Model).where(Model.model_name == spec.model_name))
        if existing is None:
            session.add(
                Model(
                    provider=spec.provider,
                    model_name=spec.model_name,
                    display_name=spec.display_name,
                    input_price_per_mtok=spec.input_price_per_mtok,
                    output_price_per_mtok=spec.output_price_per_mtok,
                    context_window=spec.context_window,
                    is_active=spec.is_active,
                )
            )
        else:
            existing.provider = spec.provider
            existing.display_name = spec.display_name
            existing.input_price_per_mtok = spec.input_price_per_mtok
            existing.output_price_per_mtok = spec.output_price_per_mtok
            existing.context_window = spec.context_window
            existing.is_active = spec.is_active
        print(f"seeded: {spec.display_name}")

    await session.commit()
