from __future__ import annotations

from functools import lru_cache
import os

from openai import OpenAI


@lru_cache(maxsize=8)
def get_openai_client(timeout: float | None = None) -> OpenAI:
    """Return a cached OpenAI client configured from the environment."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY environment variable is not set")
    return OpenAI(api_key=api_key, timeout=timeout)
