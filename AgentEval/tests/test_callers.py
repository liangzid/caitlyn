"""
Basic tests for AgentEval callers.
"""

import pytest
from agent_eval import get_caller, DEFAULT_MODEL
from agent_eval.api_keys import get_openrouter_api_key
from agent_eval.models import get_default_model_for_agent


def test_default_model():
    """Test that DEFAULT_MODEL is set correctly."""
    assert DEFAULT_MODEL == "openrouter/free"


def test_api_key_loaded():
    """Test that API key can be loaded.

    This test requires a privacy_secret_openrouter_API_key.txt file to exist.
    If it doesn't exist, the test will be skipped.
    """
    from pathlib import Path

    privacy_file = Path.home() / "privacy_secret_openrouter_API_key.txt"
    if not privacy_file.exists():
        pytest.skip("privacy_secret_openrouter_API_key.txt not found in home directory")

    api_key = get_openrouter_api_key()
    assert api_key is not None
    assert api_key.startswith("sk-or-v1-")


def test_get_caller():
    """Test that get_caller returns correct caller types."""
    agents = ["nanobot", "hermes", "zeroclaw", "openclaw", "kilo_code", "opencode"]
    for agent in agents:
        caller = get_caller(agent)
        assert caller is not None


def test_get_default_model_for_agent():
    """Test model defaults for agents."""
    assert get_default_model_for_agent("nanobot") == "openrouter/free"
    assert get_default_model_for_agent("hermes") == "openrouter/free"
    assert get_default_model_for_agent("zeroclaw") == "openrouter/free"
    assert get_default_model_for_agent("openclaw") == "openrouter/auto"
    assert get_default_model_for_agent("kilo_code") == "kilo/openrouter/free"
    assert get_default_model_for_agent("opencode") == "opencode/big-pickle"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
