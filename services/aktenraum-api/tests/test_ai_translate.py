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


def test_translate_empty_filter():
    params = filter_to_paperless_params(
        SearchFilter(), correspondent_id=None, document_type_id=None
    )
    assert params == {}


def test_translate_only_text():
    f = SearchFilter(text="urlaubsantrag")
    params = filter_to_paperless_params(f, correspondent_id=None, document_type_id=None)
    assert params == {"query": "urlaubsantrag"}


def test_translate_tags_use_id_all_csv():
    f = SearchFilter(tags=["Lebenslauf", "Versicherung"])
    params = filter_to_paperless_params(
        f,
        correspondent_id=None,
        document_type_id=None,
        tag_ids=[42, 7],
    )
    # AND semantics — Paperless's `tags__id__all` takes a comma-separated id list.
    # Order is preserved so the URL stays stable for caching.
    assert params == {"tags__id__all": "42,7"}


def test_translate_empty_tag_ids_omits_param():
    f = SearchFilter()
    params = filter_to_paperless_params(
        f, correspondent_id=None, document_type_id=None, tag_ids=[]
    )
    assert "tags__id__all" not in params


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


def test_post_filter_projects_native_fields():
    docs = [_doc(1)]
    out = apply_post_filter(
        docs,
        SearchFilter(),
        name_by_id={
            "correspondents": {12: "Telekom"},
            "document_types": {5: "Rechnung"},
        },
    )
    assert out[0].correspondent == "Telekom"
    assert out[0].document_type == "Rechnung"
    assert out[0].created == date(2024, 1, 15)


def test_post_filter_surfaces_lifecycle_tags():
    docs = [_doc(1, tags=[7, 99])]
    out = apply_post_filter(
        docs,
        SearchFilter(),
        name_by_id={"correspondents": {}, "document_types": {}},
        tag_name_by_id={7: "ai-propagated", 99: "Lebenslauf"},
        lifecycle_tag_names=frozenset({"ai-propagated"}),
    )
    assert out[0].lifecycle_tags == ["ai-propagated"]


def test_post_filter_returns_all_results_unfiltered():
    docs = [_doc(1), _doc(2), _doc(3)]
    out = apply_post_filter(
        docs,
        SearchFilter(),
        name_by_id={"correspondents": {}, "document_types": {}},
    )
    assert [d.id for d in out] == [1, 2, 3]
