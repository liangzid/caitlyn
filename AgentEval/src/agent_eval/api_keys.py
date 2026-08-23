"""API Key Management Utility

Reads API keys from privacy_*.txt files.
This keeps sensitive credentials out of source code.
"""

from pathlib import Path
from functools import lru_cache

PRIVACY_DIR = Path.home() / "privacy_secret_openrouter_API_key.txt"
AICODEMIRROR_KEY_FILE = Path.home() / "ai-code-mirror-apikey.txt"


@lru_cache(maxsize=1)
def get_openrouter_api_key() -> str:
    """Read OpenRouter API key from privacy file.

    The privacy file should be located at:
        ~/privacy_secret_openrouter_API_key.txt

    Returns:
        str: The OpenRouter API key

    Raises:
        FileNotFoundError: If the privacy file doesn't exist
        ValueError: If the key file is empty
    """
    if not PRIVACY_DIR.exists():
        raise FileNotFoundError(
            f"OpenRouter API key file not found at {PRIVACY_DIR}. "
            "Please create privacy_secret_openrouter_API_key.txt in your home directory."
        )

    api_key = PRIVACY_DIR.read_text().strip()
    if not api_key:
        raise ValueError(f"OpenRouter API key file at {PRIVACY_DIR} is empty.")

    return api_key


@lru_cache(maxsize=1)
def get_openrouter_base_url() -> str:
    """Get the OpenRouter API base URL."""
    return "https://openrouter.ai/api/v1"


@lru_cache(maxsize=1)
def get_aicodemirror_api_key() -> str:
    """Read the AICodeMirror relay API key from its privacy file.

    The relay key is never stored in source code or logs; the harness
    injects it only into the docker exec environment.
    """
    if not AICODEMIRROR_KEY_FILE.exists():
        raise FileNotFoundError(
            f"AICodeMirror key file not found at {AICODEMIRROR_KEY_FILE}."
        )
    api_key = AICODEMIRROR_KEY_FILE.read_text().strip()
    if not api_key:
        raise ValueError(f"AICodeMirror key file at {AICODEMIRROR_KEY_FILE} is empty.")
    return api_key


if __name__ == "__main__":
    print(f"Project root: {PROJECT_ROOT}")
    print(f"Privacy file: {PRIVACY_DIR}")
    print(f"API key found: {bool(PRIVACY_DIR.exists())}")
    if PRIVACY_DIR.exists():
        key = get_openrouter_api_key()
        print(f"API key (first 20 chars): {key[:20]}...")
