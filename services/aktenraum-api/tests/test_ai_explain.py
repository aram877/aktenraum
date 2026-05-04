from datetime import date

from aktenraum_core.models import DocumentType

from aktenraum_api.ai.explain import explain_filter
from aktenraum_api.ai.schemas import SearchFilter


def test_empty_filter_explains_no_constraints():
    assert explain_filter(SearchFilter()) == "Ich habe verstanden: keine Einschränkungen."


def test_doctype_and_year_range():
    f = SearchFilter(
        document_type=DocumentType.Gehaltsabrechnung,
        date_from=date(2023, 1, 1),
        date_to=date(2023, 12, 31),
    )
    out = explain_filter(f)
    assert out.startswith("Ich habe verstanden:")
    assert "Gehaltsabrechnung" in out
    assert "2023-01-01" in out
    assert "2023-12-31" in out


def test_min_max_amount_uses_german_decimal():
    out = explain_filter(SearchFilter(min_amount=3000, max_amount=5000))
    assert "3000" in out
    assert "5000" in out
    assert "zwischen" in out


def test_correspondent_and_text():
    out = explain_filter(SearchFilter(correspondent="Telekom", text="bonus"))
    assert "Telekom" in out
    assert "bonus" in out


def test_only_min_amount():
    out = explain_filter(SearchFilter(min_amount=100))
    assert "mindestens" in out


def test_only_max_amount():
    out = explain_filter(SearchFilter(max_amount=50))
    assert "höchstens" in out


def test_tags_render_as_quoted_list():
    out = explain_filter(SearchFilter(tags=["Lebenslauf", "Auto"]))
    assert "Tags" in out
    assert "'Lebenslauf'" in out
    assert "'Auto'" in out
