"""Unit tests for the ollama backend's `_recover_keys_for_schema` helper.

Lives under services/auto-tagger/tests by the same convention used for the
other aktenraum-core helpers — see CLAUDE.md ("tests for the moved modules
continue to live under services/auto-tagger/tests").
"""

from __future__ import annotations

from aktenraum_core.llm.ollama_backend import _recover_keys_for_schema
from pydantic import BaseModel


class _AnswerOutput(BaseModel):
    answer_de: str
    cited_ids: list[int] = []


def test_recover_renames_garbled_key_sharing_canonical_prefix():
    """The user-facing repro: a control-token leak corrupts a key but its
    underscore prefix still matches `answer_de`, and it's the only sibling
    sharing that prefix, so we rename it."""
    parsed = {
        "answer_<|channel|>{": "Ich konnte das in den Dokumenten nicht finden.",
        "cited_ids": [],
    }
    out = _recover_keys_for_schema(parsed, _AnswerOutput)
    assert out["answer_de"] == "Ich konnte das in den Dokumenten nicht finden."
    assert "answer_<|channel|>{" not in out
    assert out["cited_ids"] == []


def test_recover_returns_input_unchanged_when_canonical_already_present():
    """If the canonical key is already there, leave the dict alone (no
    mistaken rename of unrelated siblings)."""
    parsed = {"answer_de": "ok", "cited_ids": [1]}
    out = _recover_keys_for_schema(parsed, _AnswerOutput)
    assert out is parsed


def test_recover_skips_when_multiple_prefix_siblings():
    """Ambiguity guard: if more than one key shares the prefix, we don't
    pick — better to surface the original validation error than to guess."""
    parsed = {
        "answer_garbled1": "a",
        "answer_garbled2": "b",
        "cited_ids": [],
    }
    out = _recover_keys_for_schema(parsed, _AnswerOutput)
    # Returns the original dict, signalling no recovery was possible.
    assert out is parsed


def test_recover_preserves_other_canonical_field_names():
    """A sibling whose name is itself a different canonical schema field is
    not eligible to fill in for a missing one — we only rename garbage."""
    parsed = {"cited_ids": [1, 2]}  # answer_de missing; cited_ids is canonical
    out = _recover_keys_for_schema(parsed, _AnswerOutput)
    # cited_ids stays cited_ids; nothing to rename.
    assert out is parsed


def test_recover_no_op_for_non_dict():
    out = _recover_keys_for_schema(["not", "a", "dict"], _AnswerOutput)
    assert out == ["not", "a", "dict"]
