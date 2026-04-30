from aktenraum_api.paperless_gw import (
    _merge_custom_fields,
    _normalise_field_values,
    _plan_tag_swap,
)


def test_plan_swap_removes_named_lifecycle_tag():
    out = _plan_tag_swap(
        current_ids=[1, 5, 7],
        name_to_id={"ai-pending": 1, "ai-approved": 2, "ai-low-confidence": 5, "other": 7},
        remove=["ai-pending", "ai-low-confidence"],
        add=["ai-approved"],
    )
    assert out == [7, 2]


def test_plan_swap_idempotent_when_already_set():
    out = _plan_tag_swap(
        current_ids=[2, 7],
        name_to_id={"ai-pending": 1, "ai-approved": 2, "other": 7},
        remove=["ai-pending"],
        add=["ai-approved"],
    )
    assert out == [2, 7]


def test_plan_swap_ignores_remove_names_not_in_map():
    out = _plan_tag_swap(
        current_ids=[1, 2],
        name_to_id={"ai-pending": 1, "ai-approved": 2},
        remove=["nonexistent-tag"],
        add=[],
    )
    assert out == [1, 2]


def test_plan_swap_does_not_duplicate_add_already_present():
    out = _plan_tag_swap(
        current_ids=[2, 7],
        name_to_id={"ai-approved": 2, "other": 7},
        remove=[],
        add=["ai-approved", "other"],
    )
    assert out == [2, 7]


def test_normalise_field_values_handles_german_date():
    out = _normalise_field_values({"ai_issue_date": "01.12.2024"})
    assert out == {"ai_issue_date": "2024-12-01"}


def test_normalise_field_values_handles_german_monetary():
    out = _normalise_field_values({"ai_monetary_amount": "1.234,56 EUR"})
    assert out == {"ai_monetary_amount": "EUR1234.56"}


def test_normalise_field_values_truncates_long_strings():
    long = "x" * 200
    out = _normalise_field_values({"ai_correspondent": long})
    assert len(out["ai_correspondent"]) <= 128
    assert out["ai_correspondent"].endswith("…")


def test_normalise_field_values_passes_through_floats():
    out = _normalise_field_values({"ai_confidence": 0.75})
    assert out == {"ai_confidence": 0.75}


def test_normalise_field_values_keeps_none():
    out = _normalise_field_values({"ai_correspondent": None, "ai_issue_date": None})
    assert out == {"ai_correspondent": None, "ai_issue_date": None}


# Paperless replaces the full custom_fields array on PATCH, so a one-field
# update must merge into the existing array rather than truncate it. The
# tests below pin down that contract.


def test_merge_custom_fields_updates_in_place_preserving_others():
    existing = [
        {"field": 1, "value": "Gehaltsabrechnung"},
        {"field": 2, "value": "interact GmbH"},
        {"field": 3, "value": "2025-01-01"},
    ]
    merged = _merge_custom_fields(existing, {2: "Acme GmbH"})
    assert merged == [
        {"field": 1, "value": "Gehaltsabrechnung"},
        {"field": 2, "value": "Acme GmbH"},
        {"field": 3, "value": "2025-01-01"},
    ]


def test_merge_custom_fields_appends_when_field_was_missing():
    existing = [{"field": 1, "value": "Rechnung"}]
    merged = _merge_custom_fields(existing, {2: "Telekom"})
    assert merged == [
        {"field": 1, "value": "Rechnung"},
        {"field": 2, "value": "Telekom"},
    ]


def test_merge_custom_fields_handles_empty_existing():
    merged = _merge_custom_fields([], {1: "Rechnung", 2: "Telekom"})
    assert sorted(merged, key=lambda cf: cf["field"]) == [
        {"field": 1, "value": "Rechnung"},
        {"field": 2, "value": "Telekom"},
    ]


def test_merge_custom_fields_overwrite_with_none():
    existing = [{"field": 1, "value": "Rechnung"}]
    merged = _merge_custom_fields(existing, {1: None})
    assert merged == [{"field": 1, "value": None}]
