"""Contract between the evaluation layer and the rest of the backend.

Changing a ModelResponse field requires a database migration.
"""

from abc import ABC, abstractmethod
from datetime import datetime
from decimal import Decimal
from enum import Enum

from pydantic import BaseModel, Field


class ModelSpec(BaseModel):
    """One model under comparison, with its pricing and per-call settings."""

    provider: str = Field(description="Adapter key, e.g. 'azure_ai_foundry' or 'google_ai_studio'.")
    model_name: str = Field(description="API-facing model identifier.")
    display_name: str = Field(description="Human-readable name for the UI.")
    context_window: int = Field(description="Max input plus output tokens.")
    input_price_per_mtok: Decimal = Field(description="Current published input price.")
    output_price_per_mtok: Decimal = Field(description="Current published output price.")
    cached_input_price_per_mtok: Decimal | None = Field(default=None, description="Cached input price; None if no discount.")
    pricing_notes: str = Field(description="Caveats, e.g. tiered or promotional pricing.")
    is_active: bool = Field(description="Selectable for new evaluation runs.")
    is_judge_eligible: bool = Field(
        default=False,
        description="Whether this model may score others. Judge-eligible models never enter the compared set of a run.",
    )
    reasoning_level: str | None = Field(
        default=None,
        description="Per-model reasoning/thinking effort; adapter maps it to the provider's vocabulary. None uses the adapter default.",
    )
    request_timeout_seconds: float | None = Field(
        default=None,
        description="Per-model request deadline in seconds; slow models need longer. None uses the adapter default.",
    )
    uses_max_completion_tokens: bool = Field(
        default=False,
        description="Send the output-token cap as 'max_completion_tokens'; newer deployments reject the legacy 'max_tokens'.",
    )
    accepts_custom_temperature: bool = Field(
        default=True,
        description="Whether the deployment supports a custom temperature; provider requests use the default.",
    )
    response_format: str | None = Field(
        default=None,
        description="Provider response_format type to request, e.g. 'json_object' for guaranteed-valid JSON; None sends none.",
    )


class PriceSnapshot(BaseModel):
    """Prices copied from a ModelSpec at call time, so a later price change never rewrites history."""

    input_price_per_mtok: Decimal = Field(description="Input price at call time.")
    output_price_per_mtok: Decimal = Field(description="Output price at call time.")
    cached_input_price_per_mtok: Decimal | None = Field(default=None, description="Cached input price at call time, if any.")
    captured_at: datetime = Field(description="When this snapshot was frozen.")


class CallStatus(str, Enum):
    """Whether the call itself succeeded or failed as a transaction."""

    ok = "ok"
    failed = "failed"


class CompletionOutcome(str, Enum):
    """How the model's generation terminated, when a response was produced."""

    normal = "normal"
    truncated = "truncated"
    content_filtered = "content_filtered"
    other = "other"


class ModelResponse(BaseModel):
    """Normalized result of one model call.

    The four token counts are mutually disjoint, each billed exactly once:
    input_tokens + cached_tokens = total prompt tokens, and
    output_tokens + reasoning_tokens = total generated tokens. Adapters
    normalize each provider's usage into this convention so the cost layer
    can sum the buckets without double counting.
    """

    output_text: str = Field(description="Empty string on failure.")
    input_tokens: int = Field(
        default=0,
        description="Billed input tokens NOT served from cache. Disjoint from cached_tokens.",
    )
    output_tokens: int = Field(
        default=0,
        description="Billed generated tokens, EXCLUDING reasoning. Disjoint from reasoning_tokens.",
    )
    cached_tokens: int = Field(
        default=0,
        description="Input tokens served from cache, billed at the cached rate. Disjoint from input_tokens.",
    )
    reasoning_tokens: int = Field(
        default=0,
        description="Hidden reasoning/thinking tokens, billed at the output rate. Disjoint from output_tokens.",
    )
    latency_ms: int = Field(description="Wall-clock request to response.")
    attempts: int = Field(description="Attempts including retries.")
    status: CallStatus
    completion_outcome: CompletionOutcome | None = Field(
        default=None,
        description=(
            "How the generation terminated; None when the call failed before producing one. "
            "Any value other than 'normal' (truncated, content_filtered, other) must be "
            "EXCLUDED from quality scoring but INCLUDED in cost — the tokens were produced and billed."
        ),
    )
    error_message: str | None = Field(default=None, description="Set only when status is failed.")
    retry_after_seconds: float | None = Field(
        default=None,
        description="Normalized provider backpressure hint (from a Retry-After header); the retry layer waits this long before the next attempt. None when the provider gave none.",
    )
    tokens_estimated: bool = Field(description="True if counts are local estimates, not provider-reported.")
    prices_snapshot: PriceSnapshot


class ModelClient(ABC):
    """Abstraction a provider adapter implements to serve one model call."""

    @abstractmethod
    async def complete(
        self,
        spec: ModelSpec,
        prompt: str,
        system_prompt: str | None,
        temperature: float,
        max_output_tokens: int,
    ) -> ModelResponse:
        """Run one completion.

        Never raises on a provider error, timeout, or malformed response:
        returns a ModelResponse with status=failed and error_message set,
        so one model failing never cancels the others in a parallel run.
        """
        raise NotImplementedError
