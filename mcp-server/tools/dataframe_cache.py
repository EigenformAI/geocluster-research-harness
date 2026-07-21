"""
Module-level DataFrame cache with mtime-based invalidation and memory budget.

Shared across all tool calls within the MCP server process.
DataFrames are cached by resolved path and auto-invalidated when
the underlying file changes on disk. Evicts least-recently-used
entries when total memory exceeds MAX_CACHE_MB.

NOTE: Heavy imports (pandas) are deferred to function bodies for fast startup.
"""
from __future__ import annotations

import logging
import os
import time
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import pandas as pd

from .config import resolve_path, read_tabular

logger = logging.getLogger("geocluster-mcp.cache")

MAX_CACHE_MB = int(os.environ.get("MCP_CACHE_MAX_MB", "512"))

# resolved_path -> (df, mtime, last_access_time)
_cache: dict[str, tuple] = {}

_stats = {"hits": 0, "misses": 0, "evictions": 0}


def _memory_bytes(df) -> int:
    return int(df.memory_usage(deep=True).sum())


def _total_cached_bytes() -> int:
    return sum(_memory_bytes(entry[0]) for entry in _cache.values())


def _evict_if_needed():
    """Evict least-recently-accessed entries until under budget."""
    max_bytes = MAX_CACHE_MB * 1024 * 1024
    while _cache and _total_cached_bytes() > max_bytes:
        # Find LRU entry
        lru_path = min(_cache, key=lambda p: _cache[p][2])
        evicted_df = _cache.pop(lru_path)[0]
        _stats["evictions"] += 1
        mb = _memory_bytes(evicted_df) / (1024 * 1024)
        logger.info(f"Cache EVICT: {lru_path} ({mb:.1f}MB)")


def load(path: str, force_reload: bool = False) -> pd.DataFrame:
    """Load DataFrame, cache by resolved path. Auto-invalidates on file change."""
    resolved = resolve_path(path)
    mtime = os.path.getmtime(resolved)
    now = time.monotonic()

    if not force_reload and resolved in _cache:
        cached_df, cached_mtime, _ = _cache[resolved]
        if cached_mtime == mtime:
            _cache[resolved] = (cached_df, cached_mtime, now)
            _stats["hits"] += 1
            logger.debug(f"Cache HIT: {resolved}")
            return cached_df

    df = read_tabular(resolved)
    _cache[resolved] = (df, mtime, now)
    _stats["misses"] += 1
    mb = _memory_bytes(df) / (1024 * 1024)
    total_mb = _total_cached_bytes() / (1024 * 1024)
    logger.info(f"Cache LOAD: {resolved} ({len(df)} rows, {mb:.1f}MB, total cached: {total_mb:.1f}MB)")

    _evict_if_needed()
    return df


def get(path: str) -> Optional[pd.DataFrame]:
    """Get cached DataFrame if available and fresh, else None."""
    resolved = resolve_path(path)
    if resolved in _cache:
        mtime = os.path.getmtime(resolved)
        cached_df, cached_mtime, _ = _cache[resolved]
        if cached_mtime == mtime:
            _cache[resolved] = (cached_df, cached_mtime, time.monotonic())
            _stats["hits"] += 1
            return cached_df
        del _cache[resolved]
        _stats["misses"] += 1
        logger.info(f"Cache INVALIDATE (mtime changed): {resolved}")
    return None


def drop(path: str = None):
    """Drop one or all cached DataFrames."""
    if path:
        resolved = resolve_path(path)
        _cache.pop(resolved, None)
    else:
        _cache.clear()


def stats() -> dict:
    """Return cache statistics for diagnostics."""
    return {
        **_stats,
        "entries": len(_cache),
        "total_mb": round(_total_cached_bytes() / (1024 * 1024), 1),
        "max_mb": MAX_CACHE_MB,
    }
