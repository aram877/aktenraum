from datetime import date

from aktenraum_core.models import DocumentType

from aktenraum_api.ai.schemas import SearchFilter
from aktenraum_api.ai.translate import (
    apply_post_filter,
    filter_to_paperless_params,
)


def test_translate_all_native_fields():
    f = SearchFilter(
        document_type=DocumentType.Gehaltsabrechnung,
        correspondent="Telekom",
        date_from=date(2023, 1, 1),
        date_to=date(2023, 12, 31),
        text="bonus",
    )
    params = filter_to_paperless_params(
        f, correspondent_id=12, document_type_id=5
    )
    assert params == {
        "document_type__id": 5,
        "correspondent__id": 12,
        "created__date__gte": "2023-01-01",
        "created__date__lte": "2023-12-31",
        "query": "bonus",
    }


def test_translate_amount_fields_are_post_filter_only():
    f = SearchFilter(min_amount=3000, max_amount=5000)
    params = filter_to_paperless_params(f, correspondent_id=None, document_type_id=None)
    assert params == {}


def test_translate_empty_filter():
    params = filter_to_paperless_params(
        SearchFilter(), correspondent_id=None, document_type_id=None
    )
    assert params == {}


def test_translate_only_text():
    f = SearchFilter(text="urlaubsantrag")
    params = filter_to_paperless_params(f, correspondent_id=None, document_type_id=None)
    assert params == {"query": "urlaubsantrag"}


def _doc(doc_id: int, **overrides):
    base = {
        "id": doc_id,
        "title": f"Doc {doc_id}",
        "correspondent": 12,
        "document_type": 5,
        "created_date": "2024-01-15",
        "custom_fields": [],
    }
    base.update(overrides)
    return base


def test_post_filter_min_amount_drops_cheaper():
    docs = [
        _doc(1, custom_fields=[{"field": 99, "value": "EUR1500.00"}]),
        _doc(2, custom_fields=[{"field": 99, "value": "EUR3000.00"}]),
        _doc(3, custom_fields=[{"field": 99, "value": "EUR4500.00"}]),
    ]
    out = apply_post_filter(
        docs,
        SearchFilter(min_amount=3000),
        name_by_id={"correspondents": {12: "Telekom"}, "document_types": {5: "Rechnung"}},
        monetary_field_id=99,
    )
    assert [d.id for d in out] == [2, 3]


def test_post_filter_max_amount_drops_expensive_and_unknown():
    docs = [
        _doc(1, custom_fields=[{"field": 99, "value": "EUR50.00"}]),
        _doc(2, custom_fields=[{"field": 99, "value": "EUR99.00"}]),
        _doc(3, custom_fields=[{"field": 99, "value": "EUR200.00"}]),
        _doc(4, custom_fields=[]),  # missing amount
    ]
    out = apply_post_filter(
        docs,
        SearchFilter(max_amount=100),
        name_by_id={"correspondents": {}, "document_types": {}},
        monetary_field_id=99,
    )
    assert [d.id for d in out] == [1, 2]


def test_post_filter_no_bounds_keeps_all_including_unknowns():
    docs = [
        _doc(1, custom_fields=[{"field": 99, "value": "EUR50.00"}]),
        _doc(2, custom_fields=[]),
        _doc(3, custom_fields=[{"field": 99, "value": None}]),
    ]
    out = apply_post_filter(
        docs,
        SearchFilter(),
        name_by_id={"correspondents": {}, "document_types": {}},
        monetary_field_id=99,
    )
    assert [d.id for d in out] == [1, 2, 3]


def test_post_filter_resolves_correspondent_and_doctype_names():
    docs = [_doc(1)]
    out = apply_post_filter(
        docs,
        SearchFilter(),
        name_by_id={
            "correspondents": {12: "Telekom"},
            "document_types": {5: "Rechnung"},
        },
        monetary_field_id=None,
    )
    assert out[0].correspondent == "Telekom"
    assert out[0].document_type == "Rechnung"
    assert out[0].created == date(2024, 1, 15)


def test_post_filter_handles_german_amount_format():
    docs = [_doc(1, custom_fields=[{"field": 99, "value": "1.234,56 EUR"}])]
    out = apply_post_filter(
        docs,
        SearchFilter(min_amount=1000, max_amount=2000),
        name_by_id={"correspondents": {}, "document_types": {}},
        monetary_field_id=99,
    )
    assert len(out) == 1
