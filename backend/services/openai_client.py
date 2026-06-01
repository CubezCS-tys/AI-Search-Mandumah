from __future__ import annotations

from functools import lru_cache
import os

from openai import AsyncOpenAI, OpenAI


@lru_cache(maxsize=8)
def get_openai_client(timeout: float | None = None) -> OpenAI:
    """Return a cached OpenAI client configured from the environment."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY environment variable is not set")
    return OpenAI(api_key=api_key, timeout=timeout)


@lru_cache(maxsize=8)
def get_async_openai_client(timeout: float | None = None) -> AsyncOpenAI:
    """Return a cached async OpenAI client configured from the environment.

    Used by streaming endpoints so token generation runs on the event loop
    instead of occupying a threadpool worker for the full request lifetime.
    """
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY environment variable is not set")
    return AsyncOpenAI(api_key=api_key, timeout=timeout)

