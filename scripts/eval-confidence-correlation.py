#!/usr/bin/env python3
"""eval-confidence-correlation.py — measure whether the LLM's self-reported
`ai_confidence` predicts "approved without edits".

Background: the auto-tagger persists a `confidence` float per extraction and
two auto-approve env knobs (`AUTO_APPROVE_CONFIDENCE`, `AUTO_APPROVE_TYPES`)
gate the `ai-pending` → `ai-approved` shortcut on it. LLM-reported confidence
is famously poorly calibrated; before trusting the routing we want a
correlation check against ground truth from the propagated corpus.

This script walks every `ai-propagated` doc, joins `ai_confidence` against
two coarse "was the AI correct?" proxies:

  1. **Correspondent match**: did the AI's suggested correspondent name
     equal the native correspondent that ended up on the doc?
  2. **Document-type match**: did the AI's `ai_document_type` equal the
     native `document_type` name?

A doc counts as "approved-unedited" when BOTH match (or both are null
the same way). Edge cases (AI proposed nothing, native is unset) are
excluded from correlation but listed in the CSV so a human can audit.

Output:
  - CSV to stdout (or `--out`) — one row per doc + a `# summary` line.
  - Aggregate block to stderr (count, mean, bucket rates, Pearson).

Usage:
  PAPERLESS_BASE_URL=http://localhost:8000 \\
  PAPERLESS_API_TOKEN=... \\
    python3 scripts/eval-confidence-correlation.py
  # or
  bash scripts/eval-confidence-correlation.py --out conf-eval.csv

Exit code is always 0 — this is a measurement, not a gate. CI thresholds
are the caller's concern.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterator
from typing import Any


def _env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.stderr.write(
            f"error: {name} is required (export it or pass via env)\n"
        )
        sys.exit(2)
    return value


def _api_get(
    base: str,
    path: str,
    token: str,
    params: dict[str, str] | None = None,
) -> dict[str, Any]:
    qs = f"?{urllib.parse.urlencode(params)}" if params else ""
    req = urllib.request.Request(
        f"{base.rstrip('/')}{path}{qs}",
        headers={"Authorization": f"Token {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _iter_documents_with_tag(base: str, token: str, tag_id: int) -> Iterator[dict[str, Any]]:
    """Page through every doc carrying the given tag id. Paperless caps
    page_size at 100 in current versions."""
    page = 1
    while True:
        payload = _api_get(
            base,
            "/api/documents/",
            token,
            params={
                "tags__id__all": str(tag_id),
                "page": str(page),
                "page_size": "100",
                "ordering": "id",
            },
        )
        results = payload.get("results", [])
        if not results:
            return
        yield from results
        if not payload.get("next"):
            return
        page += 1


def _name_lookup(base: str, token: str, endpoint: str) -> dict[int, str]:
    """endpoint ∈ {/api/tags/, /api/correspondents/, /api/document_types/}.
    Returns {id: name} fetched in one walk."""
    out: dict[int, str] = {}
    url = f"{endpoint}?page_size=200"
    while url:
        full = f"{base.rstrip('/')}{url}" if url.startswith("/") else url
        req = urllib.request.Request(full, headers={"Authorization": f"Token {token}"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read())
        for row in payload.get("results", []):
            out[int(row["id"])] = row.get("name", "")
        url = payload.get("next")
    return out


def _custom_field_id_to_name(base: str, token: str) -> dict[int, str]:
    out: dict[int, str] = {}
    payload = _api_get(base, "/api/custom_fields/", token, params={"page_size": "100"})
    for row in payload.get("results", []):
        out[int(row["id"])] = row.get("name", "")
    return out


def _fields_by_name(doc: dict[str, Any], field_id_to_name: dict[int, str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for entry in doc.get("custom_fields", []) or []:
        try:
            name = field_id_to_name.get(int(entry.get("field")))
        except (TypeError, ValueError):
            name = None
        if name:
            out[name] = entry.get("value")
    return out


def _norm(s: Any) -> str:
    if s is None:
        return ""
    return str(s).strip().casefold()


def _bucket(c: float | None) -> str:
    if c is None:
        return "n/a"
    if c <= 0.5:
        return "low"
    if c <= 0.8:
        return "mid"
    return "high"


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2 or len(set(xs)) < 2 or len(set(ys)) < 2:
        return None
    mx = statistics.fmean(xs)
    my = statistics.fmean(ys)
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    denom = (
        sum((x - mx) ** 2 for x in xs) * sum((y - my) ** 2 for y in ys)
    ) ** 0.5
    if denom == 0:
        return None
    return num / denom


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", help="CSV output path; defaults to stdout")
    args = parser.parse_args()

    base = _env("PAPERLESS_BASE_URL")
    token = _env("PAPERLESS_API_TOKEN")

    tag_id_to_name = _name_lookup(base, token, "/api/tags/")
    propagated_id = next(
        (i for i, n in tag_id_to_name.items() if n == "ai-propagated"), None
    )
    if propagated_id is None:
        sys.stderr.write("error: `ai-propagated` tag not found in Paperless\n")
        return 2

    correspondent_lookup = _name_lookup(base, token, "/api/correspondents/")
    doctype_lookup = _name_lookup(base, token, "/api/document_types/")
    field_id_to_name = _custom_field_id_to_name(base, token)

    rows: list[dict[str, Any]] = []
    for doc in _iter_documents_with_tag(base, token, propagated_id):
        fields = _fields_by_name(doc, field_id_to_name)
        ai_conf_raw = fields.get("ai_confidence")
        try:
            ai_conf = float(ai_conf_raw) if ai_conf_raw is not None else None
        except (TypeError, ValueError):
            ai_conf = None

        ai_corresp = fields.get("ai_correspondent")
        ai_doctype = fields.get("ai_document_type")
        native_corresp = correspondent_lookup.get(doc.get("correspondent") or -1, "")
        native_doctype = doctype_lookup.get(doc.get("document_type") or -1, "")

        corresp_match = _norm(ai_corresp) == _norm(native_corresp)
        doctype_match = _norm(ai_doctype) == _norm(native_doctype)
        unedited = corresp_match and doctype_match

        rows.append(
            {
                "doc_id": doc["id"],
                "title": doc.get("title", ""),
                "ai_confidence": ai_conf if ai_conf is not None else "",
                "ai_correspondent": ai_corresp or "",
                "native_correspondent": native_corresp,
                "correspondent_match": int(corresp_match),
                "ai_document_type": ai_doctype or "",
                "native_document_type": native_doctype,
                "document_type_match": int(doctype_match),
                "approved_unedited": int(unedited),
                "confidence_bucket": _bucket(ai_conf),
            }
        )

    fieldnames = list(rows[0].keys()) if rows else [
        "doc_id",
        "title",
        "ai_confidence",
        "ai_correspondent",
        "native_correspondent",
        "correspondent_match",
        "ai_document_type",
        "native_document_type",
        "document_type_match",
        "approved_unedited",
        "confidence_bucket",
    ]

    out_stream = open(args.out, "w", newline="") if args.out else sys.stdout
    try:
        writer = csv.DictWriter(out_stream, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)
    finally:
        if args.out:
            out_stream.close()

    bucket_counts: dict[str, list[int]] = {"low": [], "mid": [], "high": [], "n/a": []}
    confidences: list[float] = []
    unedited_flags: list[float] = []
    for row in rows:
        bucket = row["confidence_bucket"]
        bucket_counts[bucket].append(row["approved_unedited"])
        if isinstance(row["ai_confidence"], float):
            confidences.append(row["ai_confidence"])
            unedited_flags.append(float(row["approved_unedited"]))

    sys.stderr.write("\n# summary\n")
    sys.stderr.write(f"  rows: {len(rows)}\n")
    if confidences:
        sys.stderr.write(
            f"  mean ai_confidence: {statistics.fmean(confidences):.3f}\n"
        )
    for bucket in ("low", "mid", "high"):
        flags = bucket_counts[bucket]
        if flags:
            rate = sum(flags) / len(flags)
            sys.stderr.write(
                f"  {bucket:>4} (n={len(flags)}): "
                f"approved-unedited rate {rate:.2%}\n"
            )
        else:
            sys.stderr.write(f"  {bucket:>4}: n=0\n")
    if bucket_counts["n/a"]:
        sys.stderr.write(
            f"  no confidence on file: n={len(bucket_counts['n/a'])}\n"
        )
    pearson = _pearson(confidences, unedited_flags)
    if pearson is None:
        sys.stderr.write(
            "  Pearson correlation: not enough variance to compute\n"
        )
    else:
        sys.stderr.write(f"  Pearson(confidence, approved-unedited): {pearson:.3f}\n")
    sys.stderr.write(
        "\n  Decision criterion: if Pearson < ~0.3 across N >= 50 docs, the\n"
        "  confidence-based auto-approve gate is routing on noise. Consider\n"
        "  dropping AUTO_APPROVE_CONFIDENCE in favour of rule-based gates\n"
        "  (e.g. allowlisted doctype + known correspondent).\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
