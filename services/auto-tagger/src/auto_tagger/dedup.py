"""Backward-compat re-export — the dedup logic now lives in
`aktenraum_core.dedup` so aktenraum-api can re-use it for the
duplicate-candidates endpoint without importing from auto-tagger.
"""

from aktenraum_core.dedup import DocFields, find_duplicates

__all__ = ["DocFields", "find_duplicates"]
