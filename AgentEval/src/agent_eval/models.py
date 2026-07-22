"""
Model Registry and Defaults

This module provides model configuration and defaults for agent evaluation.
"""

DEFAULT_MODEL = "openrouter/free"

AGENT_DEFAULT_MODELS = {
    "nanobot": "openrouter/free",
    "hermes": "openrouter/free",
    "zeroclaw": "openrouter/free",
    "openclaw": "openrouter/auto",
    "kilo_code": "kilo/openrouter/free",
    "opencode": "opencode/big-pickle",
    "codex": "openrouter/free",
    "claude_code": "anthropic/claude-sonnet-4.6",
    "droid": "openrouter/free",
    "grok_cli": "openrouter/free",
}

OPENROUTER_FREE_MODELS = [
    "openrouter/free",
    "openrouter/auto",
    "qwen/qwen3-coder:free",
    "google/gemma-3-27b-it:free",
    "google/gemma-3-12b-it:free",
    "google/gemma-3-4b-it:free",
    "meta-llama/llama-3.2-3b-instruct:free",
    "z-ai/glm-4.5-air:free",
    "kilo/openrouter/free",
]

ALL_SUPPORTED_MODELS = [
    "openrouter/free",
    "openrouter/auto",
    "anthropic/claude-sonnet-4.6",
    "anthropic/claude-opus-4",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
    "google/gemini-2.0-flash-001",
    "qwen/qwen3-coder:free",
    "opencode/big-pickle",
    "opencode/gpt-5-nano",
    "kilo/openrouter/free",
]


def get_default_model_for_agent(agent_type: str) -> str:
    """Get the default model for a specific agent type."""
    return AGENT_DEFAULT_MODELS.get(agent_type, DEFAULT_MODEL)
