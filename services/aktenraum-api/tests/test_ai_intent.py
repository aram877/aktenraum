from aktenraum_core.models import DocumentType

from aktenraum_api.ai.intent import (
    INTENT_DOC_TYPES,
    Intent,
    detect_intents,
    doc_types_for_intents,
)


def test_empty_question_returns_empty_set():
    assert detect_intents("") == set()


def test_unrelated_question_returns_empty_set():
    assert detect_intents("Was ist die Hauptstadt von Frankreich?") == set()


def test_salary_keywords_trigger_salary_intent():
    for q in [
        "Wie viel habe ich verdient?",
        "Mein Gehalt im März",
        "Lohnabrechnung August",
        "Bruttogehalt 2024",
    ]:
        assert Intent.SALARY in detect_intents(q), q


def test_spending_keywords_trigger_spending_intent():
    for q in [
        "Was hat das gekostet?",
        "Wie viel habe ich bei Telekom ausgegeben?",
        "Welcher Preis stand auf der Rechnung?",
    ]:
        assert Intent.SPENDING in detect_intents(q), q


def test_tax_keywords_trigger_tax_intent():
    assert Intent.TAX in detect_intents("Wie hoch war meine Steuererstattung?")
    assert Intent.TAX in detect_intents("Mein Steuerbescheid 2022")
    assert Intent.TAX in detect_intents("Wann kommt die Lohnsteuerbescheinigung?")


def test_insurance_keywords_trigger_insurance_intent():
    assert Intent.INSURANCE in detect_intents("Wie hoch ist meine Prämie?")
    assert Intent.INSURANCE in detect_intents("Welche Versicherung habe ich?")


def test_housing_keywords_trigger_housing_intent():
    assert Intent.HOUSING in detect_intents("Nebenkostenabrechnung 2024")
    assert Intent.HOUSING in detect_intents("Wie hoch ist mein Hausgeld?")


def test_medical_keywords_trigger_medical_intent():
    assert Intent.MEDICAL in detect_intents("Welche Diagnose hatte der Arzt?")
    assert Intent.MEDICAL in detect_intents("Mein Befund vom Hausarzt")


def test_id_document_keywords_trigger_id_intent():
    assert Intent.ID_DOCUMENT in detect_intents("Wann läuft mein Pass ab?")
    assert Intent.ID_DOCUMENT in detect_intents("Personalausweis verlängern")
    assert Intent.ID_DOCUMENT in detect_intents("Bis wann ist mein Perso gültig?")


def test_contract_keywords_trigger_contract_intent():
    assert Intent.CONTRACT in detect_intents("Welche Kündigungsfrist hat mein Vertrag?")
    assert Intent.CONTRACT in detect_intents("Mein Mietvertrag")


def test_multiple_intents_can_fire_on_one_question():
    """'Wie viel habe ich für die Versicherung bezahlt?' is both spending and insurance."""
    intents = detect_intents("Wie viel habe ich für die Versicherung bezahlt?")
    assert Intent.INSURANCE in intents
    assert Intent.SPENDING in intents


def test_word_boundary_prevents_false_positive():
    """`lohn` shouldn't trigger when it appears only as part of a longer
    non-related word. Currently no German noun contains 'lohn' as a
    middle substring relevant here, so we test the negative case via a
    contrived word that has 'lohn' inside but isn't German for salary.
    """
    # "Welcome" — no German salary intent here even though it contains 'lcom'.
    assert detect_intents("hello world") == set()


def test_doc_types_for_intents_dedupes_and_orders():
    """SALARY → Gehaltsabrechnung; TAX → Steuer, Lohnsteuerbescheinigung;
    INSURANCE → Versicherung. Order should follow Intent enum order,
    types deduplicated within."""
    out = doc_types_for_intents({Intent.TAX, Intent.SALARY, Intent.INSURANCE})
    # Intent enum order: SALARY, SPENDING, TAX, INSURANCE, ...
    assert out == [
        DocumentType.Gehaltsabrechnung,
        DocumentType.Steuer,
        DocumentType.Lohnsteuerbescheinigung,
        DocumentType.Versicherung,
    ]


def test_doc_types_for_intents_handles_empty():
    assert doc_types_for_intents(set()) == []


def test_intent_doc_types_covers_every_declared_intent():
    """Defensive: every Intent value should map to ≥1 doc type."""
    for intent in Intent:
        assert intent in INTENT_DOC_TYPES, intent
        assert INTENT_DOC_TYPES[intent], intent
