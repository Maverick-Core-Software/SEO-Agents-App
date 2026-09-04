"""Tests for cross-provider LLM failover in seo_agents.crew.

The crew's primary provider (Venice) has no free tier, so a 429, a 402
"insufficient credits", or a connection failure used to take the whole run
down. build_*_llm now wraps the primary so that provider-availability
failures retry once on CREWAI_<TIER>_FALLBACK_*.

Covers:
- the wrapper attaches to the concrete provider class crewai.LLM returns;
- rate limit, out-of-credits, and connection failures fail over;
- context-length and malformed-request errors do NOT fail over;
- an unconfigured fallback leaves behaviour unchanged.
"""

from __future__ import annotations

import pytest

from crewai.llms.providers.openai.completion import OpenAICompletion

from seo_agents.crew import _is_provider_down, build_research_llm

PRIMARY = "primary-model"
FALLBACK = "fallback-model"


class _ProviderError(Exception):
    """Stand-in for a litellm/openai transport error."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status


@pytest.fixture
def failover_env(monkeypatch):
    """Point RESEARCH at a primary and a fallback, both unreachable by design.

    build_*_llm calls load_dotenv(), so without this stub a developer's real
    .env leaks into the test: deleting CREWAI_RESEARCH_FALLBACK_MODEL would be
    silently undone by the value on disk.
    """
    monkeypatch.setattr("seo_agents.crew.load_dotenv", lambda *a, **k: False)
    monkeypatch.setenv("CREWAI_RESEARCH_MODEL", PRIMARY)
    monkeypatch.setenv("CREWAI_RESEARCH_API_BASE", "https://primary.invalid/v1")
    monkeypatch.setenv("CREWAI_RESEARCH_API_KEY", "primary-key")
    monkeypatch.setenv("CREWAI_RESEARCH_FALLBACK_MODEL", FALLBACK)
    monkeypatch.setenv(
        "CREWAI_RESEARCH_FALLBACK_API_BASE", "https://fallback.invalid/v1"
    )
    monkeypatch.setenv("CREWAI_RESEARCH_FALLBACK_API_KEY", "fallback-key")


@pytest.fixture
def stub_provider(monkeypatch):
    """Fail the primary with a chosen error; succeed on the fallback.

    Patches the concrete provider class, not crewai.LLM: LLM(...) is a factory
    that returns OpenAICompletion, and that subclass overrides call().
    """
    state: dict[str, BaseException] = {}

    def fake_call(self, *args, **kwargs):
        if self.model == PRIMARY:
            raise state["error"]
        return "FALLBACK_OK"

    monkeypatch.setattr(OpenAICompletion, "call", fake_call)
    return state


def test_wrapper_targets_the_concrete_provider_class(failover_env):
    """crewai.LLM is a factory, so the wrapper must subclass what it returns."""
    llm = build_research_llm()

    assert type(llm).__name__ == "FailoverOpenAICompletion"
    assert isinstance(llm, OpenAICompletion)
    fallback, tier = llm.__dict__["_seo_failover"]
    assert (llm.model, fallback.model, tier) == (PRIMARY, FALLBACK, "RESEARCH")


@pytest.mark.parametrize(
    ("message", "status"),
    [
        ("rate limit exceeded", 429),
        ("Insufficient credits for this request", 402),
        ("Invalid API key provided", 401),
        ("Service Unavailable", 503),
        ("Connection error.", None),
    ],
    ids=["rate-limit", "out-of-credits", "revoked-key", "upstream-down", "connection"],
)
def test_provider_outage_fails_over(failover_env, stub_provider, message, status):
    stub_provider["error"] = _ProviderError(message, status)

    assert build_research_llm().call("hi") == "FALLBACK_OK"


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            _ProviderError("This model's maximum context length is 8192 tokens", 400),
            _ProviderError,
        ),
        (ValueError("invalid tool schema"), ValueError),
    ],
    ids=["context-length", "malformed-request"],
)
def test_request_shaped_errors_do_not_fail_over(
    failover_env, stub_provider, error, expected
):
    """These follow the request, not the vendor - retrying elsewhere only
    burns the fallback's credits on the identical failure."""
    stub_provider["error"] = error

    with pytest.raises(expected):
        build_research_llm().call("hi")


def test_unconfigured_fallback_leaves_behaviour_unchanged(
    failover_env, stub_provider, monkeypatch
):
    """Failover is opt-in: with no *_FALLBACK_MODEL the error propagates."""
    monkeypatch.delenv("CREWAI_RESEARCH_FALLBACK_MODEL")
    llm = build_research_llm()

    assert "_seo_failover" not in llm.__dict__
    assert not type(llm).__name__.startswith("Failover")

    stub_provider["error"] = _ProviderError("rate limit exceeded", 429)
    with pytest.raises(_ProviderError):
        llm.call("hi")


@pytest.mark.parametrize(
    "message",
    ["429 Too Many Requests", "insufficient quota", "Connection refused", "timed out"],
)
def test_is_provider_down_recognises_outages(message):
    assert _is_provider_down(_ProviderError(message))


@pytest.mark.parametrize(
    "message",
    ["maximum context length is 8192", "invalid tool schema", "unknown parameter"],
)
def test_is_provider_down_ignores_request_errors(message):
    assert not _is_provider_down(_ProviderError(message))


# ---------------------------------------------------------------------------
# Construction-time failure (2026-09-04): the primary could not even be built
# because a venv re-sync dropped the provider SDK. The call() wrapper never
# existed, so the configured fallback was useless and the Friday run died.
# ---------------------------------------------------------------------------


@pytest.fixture
def primary_unbuildable(monkeypatch):
    """Make LLM(model=PRIMARY) raise the way crewai does for a missing SDK."""
    import seo_agents.crew as crew_mod

    real_llm = crew_mod.LLM

    def exploding_llm(*args, **kwargs):
        if kwargs.get("model") == PRIMARY:
            raise ImportError("Anthropic native provider not available")
        return real_llm(*args, **kwargs)

    monkeypatch.setattr(crew_mod, "LLM", exploding_llm)


def test_unbuildable_primary_runs_tier_on_fallback(failover_env, primary_unbuildable):
    llm = build_research_llm()
    assert llm.model == FALLBACK
    # Plain fallback, no wrapper: there is no primary left to fail over from.
    assert "_seo_failover" not in llm.__dict__


def test_unbuildable_primary_without_fallback_still_raises(
    failover_env, primary_unbuildable, monkeypatch
):
    monkeypatch.delenv("CREWAI_RESEARCH_FALLBACK_MODEL")
    with pytest.raises(ImportError):
        build_research_llm()
