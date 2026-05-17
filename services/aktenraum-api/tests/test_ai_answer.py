from __future__ import annotations

from unittest.mock import AsyncMock

from aktenraum_core.models import DocumentType
from httpx import AsyncClient
from pydantic import BaseModel

from aktenraum_api.ai.answer_prompt import build_answer_messages
from aktenraum_api.ai.deps import (
    get_answer_llm_backend,
    get_llm_backend,
    get_paperless_gateway,
)
from aktenraum_api.ai.schemas import AnswerOutput, SearchFilter

# ---- Prompt unit tests ----


def _system(messages):
    return next(m["content"] for m in messages if m["role"] == "system")


def _user(messages):
    return next(m["content"] for m in messages if m["role"] == "user")


def test_answer_prompt_states_german_only_and_short():
    msgs = build_answer_messages("Wann läuft mein Pass ab?", candidates=[])
    sys = _system(msgs)
    assert "Deutsch" in sys
    assert "höchstens 3" in sys


def test_answer_prompt_includes_candidate_metadata():
    candidates = [
        {
            "id": 17,
            "title": "Perso Aram",
            "correspondent": "Bundesrepublik",
            "document_type": "Ausweis",
            "created": "2024-02-28",
            "ai_summary_de": "Personalausweis ausgestellt am 28.02.2024.",
            "ai_issue_date": "2024-02-28",
            "ai_reference_numbers": "L01XYZ",
        }
    ]
    msgs = build_answer_messages("Wann wurde mein Pass ausgestellt?", candidates=candidates)
    user = _user(msgs)
    assert "Dokument 17" in user
    assert "Perso Aram" in user
    assert "2024-02-28" in user
    assert "Personalausweis ausgestellt" in user


def test_answer_prompt_skips_null_fields():
    candidates = [
        {
            "id": 5,
            "title": "Rechnung",
            "correspondent": None,
            "document_type": "Rechnung",
            "created": None,
            "ai_summary_de": None,
            "ai_issue_date": None,
            "ai_reference_numbers": None,
        }
    ]
    msgs = build_answer_messages("test", candidates=candidates)
    user = _user(msgs)
    # Null lines should not leak as "Korrespondent: None"
    assert "None" not in user


def test_answer_prompt_handles_empty_candidates():
    msgs = build_answer_messages("test", candidates=[])
    user = _user(msgs)
    assert "(keine)" in user


def test_answer_prompt_includes_type_specific_fields():
    """Without these the LLM has no money figures for the most common
    personal-DMS question — "Wie viel habe ich verdient?" / "Was kostet
    die Versicherung?". The pass-2 fields are the canonical place."""
    candidates = [
        {
            "id": 42,
            "title": "Gehaltsabrechnung Acme GmbH September 2024",
            "correspondent": "Acme GmbH",
            "document_type": "Gehaltsabrechnung",
            "created": "2024-09-30",
            "ai_summary_de": "Gehaltsabrechnung für September 2024.",
            "ai_issue_date": "2024-09-30",
            "ai_reference_numbers": None,
            "type_specific_fields": [
                {"name": "bruttogehalt", "label": "Bruttogehalt", "value": "EUR3500.00"},
                {"name": "nettogehalt", "label": "Nettogehalt", "value": "EUR2200.00"},
                {"name": "abrechnungsmonat", "label": "Abrechnungsmonat", "value": "2024-09"},
            ],
        }
    ]
    msgs = build_answer_messages("Wie viel habe ich verdient?", candidates=candidates)
    user = _user(msgs)
    assert "Typenspezifische Felder" in user
    assert "Bruttogehalt: EUR3500.00" in user
    assert "Nettogehalt: EUR2200.00" in user
    assert "Abrechnungsmonat: 2024-09" in user


def test_answer_prompt_aggregates_multi_doc_salary():
    """Annual query: 2 payslips → pre-computed sums appear before the doc list."""
    from aktenraum_api.ai.answer_prompt import _compute_type_aggregations

    candidates = [
        {
            "id": 10,
            "document_type": "Gehaltsabrechnung",
            "type_specific_fields": [
                {"name": "bruttogehalt", "label": "Bruttogehalt", "value": "EUR4200.00"},
                {"name": "nettogehalt", "label": "Nettogehalt", "value": "EUR2700.00"},
            ],
        },
        {
            "id": 11,
            "document_type": "Gehaltsabrechnung",
            "type_specific_fields": [
                {"name": "bruttogehalt", "label": "Bruttogehalt", "value": "EUR4200.00"},
                {"name": "nettogehalt", "label": "Nettogehalt", "value": "EUR2700.00"},
            ],
        },
    ]
    lines = _compute_type_aggregations(candidates)
    block = "\n".join(lines)
    assert "Berechnete Summen" in block
    assert "EUR8400.00" in block  # 4200 + 4200
    assert "EUR5400.00" in block  # 2700 + 2700


def test_answer_prompt_no_aggregation_for_single_doc():
    from aktenraum_api.ai.answer_prompt import _compute_type_aggregations

    candidates = [
        {
            "id": 10,
            "document_type": "Gehaltsabrechnung",
            "type_specific_fields": [
                {"name": "bruttogehalt", "label": "Bruttogehalt", "value": "EUR4200.00"},
            ],
        }
    ]
    assert _compute_type_aggregations(candidates) == []


def test_answer_prompt_aggregation_injected_into_streaming_prompt():
    """The pre-computed sums block appears in the streaming user message."""
    from aktenraum_api.ai.answer_prompt import build_streaming_answer_messages

    candidates = [
        {
            "id": i,
            "title": f"Gehaltsabrechnung {i}",
            "correspondent": "Acme",
            "document_type": "Gehaltsabrechnung",
            "created": f"2023-{i:02d}-28",
            "ai_summary_de": None,
            "ai_issue_date": None,
            "ai_reference_numbers": None,
            "type_specific_fields": [
                {"name": "bruttogehalt", "label": "Bruttogehalt", "value": "EUR4000.00"},
                {"name": "nettogehalt", "label": "Nettogehalt", "value": "EUR2600.00"},
            ],
        }
        for i in range(1, 4)  # 3 payslips
    ]
    msgs = build_streaming_answer_messages(
        "Wie viel habe ich 2023 verdient?", candidates=candidates
    )
    user = msgs[1]["content"]
    assert "Berechnete Summen" in user
    assert "EUR12000.00" in user  # 3 × 4000
    assert "EUR7800.00" in user   # 3 × 2600


def test_answer_prompt_omits_type_section_when_empty():
    candidates = [
        {
            "id": 5,
            "title": "Rechnung",
            "correspondent": "Vodafone",
            "document_type": "Rechnung",
            "created": "2024-03-15",
            "ai_summary_de": "Rechnung.",
            "ai_issue_date": "2024-03-15",
            "ai_reference_numbers": None,
            "type_specific_fields": [],
        }
    ]
    msgs = build_answer_messages("test", candidates=candidates)
    user = _user(msgs)
    # `_render_candidate` uses a two-space indent on the section header
    # when it actually emits one; the dynamic module example uses none.
    # We must NOT see the indented form (candidate-render path) and we
    # MAY see the no-indent form (module example demonstrating field
    # use). This keeps the original guard — empty type_specific_fields
    # produces no candidate-side section — without conflicting with the
    # new modular example block.
    assert "\n  Typenspezifische Felder:" not in user


def test_answer_prompt_assembles_per_type_field_hints():
    """The system message should reference the salary fields when at
    least one Gehaltsabrechnung is in the candidate set — that's how
    the prompt teaches the LLM to read Brutto/Nettogehalt."""
    candidates = [
        {
            "id": 1,
            "title": "Gehalt August 2025",
            "correspondent": "Acme",
            "document_type": "Gehaltsabrechnung",
            "created": "2025-08-31",
        }
    ]
    msgs = build_answer_messages("Wie viel habe ich verdient?", candidates=candidates)
    system = _system(msgs)
    assert "Gehaltsabrechnung-Dokumente" in system
    # The schema's German label "Bruttogehalt" must surface so the model
    # knows which typespecific field to read.
    assert "Bruttogehalt" in system
    assert "Nettogehalt" in system


def test_answer_prompt_assembles_per_type_examples():
    """The user message should include the salary example when a
    Gehaltsabrechnung is in the candidates."""
    candidates = [
        {
            "id": 1,
            "title": "Gehalt August 2025",
            "correspondent": "Acme",
            "document_type": "Gehaltsabrechnung",
            "created": "2025-08-31",
        }
    ]
    msgs = build_answer_messages("Wie viel habe ich verdient?", candidates=candidates)
    user = _user(msgs)
    # The module's answer_example references brutto/netto figures.
    assert "brutto" in user.lower()
    assert "verdient" in user


def test_answer_prompt_falls_back_when_no_known_doc_types():
    """Empty candidates / unknown types should produce a generic field
    hint so the system message is never rules-less."""
    msgs = build_answer_messages("Hallo?", candidates=[])
    system = _system(msgs)
    assert "Nutze die typenspezifischen Felder" in system


def test_answer_prompt_dedupes_field_hints_across_candidates():
    """Two Gehaltsabrechnungen → one hint line, not two."""
    candidates = [
        {
            "id": 1,
            "title": "Gehalt Juli",
            "document_type": "Gehaltsabrechnung",
        },
        {
            "id": 2,
            "title": "Gehalt August",
            "document_type": "Gehaltsabrechnung",
        },
    ]
    msgs = build_answer_messages("verdient", candidates=candidates)
    system = _system(msgs)
    assert system.count("Gehaltsabrechnung-Dokumente") == 1


# ---- Denial detector unit tests ----


def test_is_denial_answer_trips_on_prompt_template():
    """The bake-baked denial template the system prompt teaches the model."""
    from aktenraum_api.ai.router import _is_denial_answer

    assert _is_denial_answer("Ich konnte das in den Dokumenten nicht finden.")


def test_is_denial_answer_trips_on_common_variants():
    from aktenraum_api.ai.router import _is_denial_answer

    assert _is_denial_answer(
        "Die Antwort steht nicht in den bereitgestellten Dokumenten."
    )
    assert _is_denial_answer(
        "Keines der Dokumente enthält diese Information."
    )
    assert _is_denial_answer("Ich habe keine passenden Dokumente gefunden.")


def test_is_denial_answer_ignores_real_prose():
    """A real answer that mentions 'nicht' must NOT trip the detector."""
    from aktenraum_api.ai.router import _is_denial_answer

    assert not _is_denial_answer(
        "Dein Pass läuft am 12.05.2030 ab. [Quelle: 17]"
    )
    assert not _is_denial_answer(
        "Du hast 4.200 € verdient. Steuern sind nicht ausgewiesen. [Quelle: 5]"
    )


def test_is_denial_answer_ignores_empty():
    from aktenraum_api.ai.router import _is_denial_answer

    assert not _is_denial_answer("")
    assert not _is_denial_answer("   ")


def test_is_denial_answer_ignores_long_partial_answer():
    """A long answer that happens to include a denial phrase is treated as
    real content — the user gets to keep their citations even though one
    field is missing."""
    from aktenraum_api.ai.router import _is_denial_answer

    long_partial = (
        "Du hast bei Wizz Air drei Flüge gebucht: nach Bukarest, nach Sofia "
        "und nach Warschau. Die genauen Preise konnte ich in den Dokumenten "
        "nicht finden, aber die Buchungsbestätigungen sind verlinkt. "
        "Insgesamt hast du in 2024 mehrere Flüge gebucht."
    )
    assert not _is_denial_answer(long_partial)


# ---- Router tests ----


class _ScriptedBackend:
    """Returns scripted outputs in order based on the response_schema requested.

    The answer endpoint makes two LLM calls: filter extraction (SearchFilter)
    then answer generation (AnswerOutput). Map by schema so the tests stay
    declarative without coupling to call order. `stream_text` is also
    scriptable so tests can drive the SSE endpoint deterministically.
    """

    def __init__(
        self,
        *,
        on_filter: SearchFilter,
        on_answer: AnswerOutput | Exception | None = None,
        stream_chunks: list[str] | Exception | None = None,
    ) -> None:
        self._on_filter = on_filter
        self._on_answer = on_answer
        self._stream_chunks = stream_chunks
        self.calls: list[tuple[str, list[dict]]] = []

    async def complete(self, messages, response_schema: type[BaseModel]):
        if response_schema is SearchFilter:
            self.calls.append(("filter", messages))
            return self._on_filter
        if response_schema is AnswerOutput:
            self.calls.append(("answer", messages))
            if isinstance(self._on_answer, Exception):
                raise self._on_answer
            assert self._on_answer is not None, (
                "Test asked for an answer call but no AnswerOutput was scripted"
            )
            return self._on_answer
        raise AssertionError(f"Unexpected schema {response_schema!r}")

    async def stream_text(self, messages):
        self.calls.append(("stream", messages))
        if isinstance(self._stream_chunks, Exception):
            raise self._stream_chunks
        for chunk in self._stream_chunks or []:
            yield chunk

    @property
    def name(self) -> str:
        return "scripted"

    @property
    def model(self) -> str:
        return "scripted-model"


def _doc(
    doc_id: int,
    *,
    title: str,
    correspondent_id: int | None,
    document_type_id: int | None,
    custom_fields: list[dict] | None = None,
):
    return {
        "id": doc_id,
        "title": title,
        "correspondent": correspondent_id,
        "document_type": document_type_id,
        "created_date": "2024-02-28",
        "custom_fields": custom_fields or [],
    }


def _make_gateway(
    *,
    correspondents: dict[str, int] | None = None,
    document_types: dict[str, int] | None = None,
    documents: list[dict] | None = None,
    field_ids: dict[str, int] | None = None,
):
    gateway = AsyncMock()
    gateway.list_correspondents = AsyncMock(return_value=correspondents or {})
    gateway.list_document_types = AsyncMock(return_value=document_types or {})
    gateway.list_tags = AsyncMock(return_value={})
    docs_by_id = {d["id"]: d for d in (documents or [])}
    gateway.search_documents = AsyncMock(
        return_value={
            "results": list(docs_by_id.values()),
            "count": len(docs_by_id),
        }
    )
    gateway.get_document = AsyncMock(
        side_effect=lambda doc_id: docs_by_id[doc_id]
    )
    gateway._get_custom_field_ids = AsyncMock(return_value=field_ids or {})
    return gateway


async def _logged_in(client_factory, **overrides):
    app, settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
        PAPERLESS_API_TOKEN="dummy",
        **overrides,
    )
    return app, settings, transport


async def _login(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "topsecret"},
    )
    assert resp.status_code == 200


async def test_answer_requires_auth(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            resp = await c.post("/api/ai/answer", json={"question": "Hallo?"})
    assert resp.status_code == 401


async def test_answer_no_matches_short_circuits_without_second_call(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    backend = _ScriptedBackend(on_filter=SearchFilter(text="non-existent-thing"))
    gateway = _make_gateway(documents=[])
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer", json={"question": "wo ist xyz"}
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["citations"] == []
    assert body["total"] == 0
    assert "nicht" in body["answer_de"].lower() or "keine" in body["answer_de"].lower()
    # Only the filter call should have happened.
    assert [c[0] for c in backend.calls] == ["filter"]


async def test_answer_question_returns_prose_with_citations(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    field_ids = {
        "ai_summary_de": 9,
        "ai_issue_date": 3,
    }
    perso_doc = _doc(
        17,
        title="Perso Aram",
        correspondent_id=12,
        document_type_id=5,
        custom_fields=[
            {
                "field": 9,
                "value": "Personalausweis ausgestellt am 28.02.2024.",
            },
            {"field": 3, "value": "2024-02-28"},
        ],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(document_type=DocumentType.Ausweis),
        on_answer=AnswerOutput(
            answer_de="Dein Personalausweis wurde am 28.02.2024 ausgestellt.",
            cited_ids=[17],
        ),
    )
    gateway = _make_gateway(
        correspondents={"Bundesrepublik": 12},
        document_types={"Ausweis": 5},
        documents=[perso_doc],
        field_ids=field_ids,
    )
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer",
                json={"question": "Wann muss ich meinen Personalausweis verlängern?"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "28.02.2024" in body["answer_de"]
    assert len(body["citations"]) == 1
    assert body["citations"][0]["id"] == 17
    assert body["filter"]["document_type"] == "Ausweis"
    # Both LLM calls occurred, in order.
    assert [c[0] for c in backend.calls] == ["filter", "answer"]


async def test_answer_drops_hallucinated_ids(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    real_doc = _doc(
        17,
        title="Perso Aram",
        correspondent_id=12,
        document_type_id=5,
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(document_type=DocumentType.Ausweis),
        on_answer=AnswerOutput(
            answer_de="Beleg in Dokument 17.",
            cited_ids=[17, 999, 42],  # 999/42 do not exist
        ),
    )
    gateway = _make_gateway(
        document_types={"Ausweis": 5},
        documents=[real_doc],
        field_ids={"ai_summary_de": 9},
    )
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/ai/answer", json={"question": "?"})

    assert resp.status_code == 200
    body = resp.json()
    assert [c["id"] for c in body["citations"]] == [17]


async def test_answer_drops_text_when_structural_constraint_present(client_factory):
    """When the filter has a doc_type, the answer pipeline should drop the
    text query so verbs like "verlängern" don't kill recall.
    """
    app, _settings, transport = await _logged_in(client_factory)
    perso = _doc(
        17,
        title="Perso Aram",
        correspondent_id=12,
        document_type_id=5,
        custom_fields=[
            {"field": 3, "value": "2024-02-28"},
            {"field": 9, "value": "Personalausweis ausgestellt 2024-02-28."},
        ],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(
            document_type=DocumentType.Ausweis, text="verlängern"
        ),
        on_answer=AnswerOutput(
            answer_de="Dein Personalausweis wurde am 28.02.2024 ausgestellt.",
            cited_ids=[17],
        ),
    )
    gateway = _make_gateway(
        document_types={"Ausweis": 5},
        documents=[perso],
        field_ids={"ai_issue_date": 3, "ai_summary_de": 9},
    )
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer",
                json={"question": "Wann muss ich meinen Personalausweis verlängern?"},
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["citations"] and body["citations"][0]["id"] == 17
    # Inspect the params actually sent to Paperless: no `query` (text) param.
    gateway.search_documents.assert_awaited()
    sent_params = gateway.search_documents.await_args.args[0]
    assert "query" not in sent_params
    assert sent_params.get("document_type__id") == 5


async def test_answer_keeps_text_when_only_text_constraint(client_factory):
    """If the filter is text-only (no doc_type / correspondent / dates),
    keep text — there's no other handle to narrow the search.
    """
    app, _settings, transport = await _logged_in(client_factory)
    backend = _ScriptedBackend(
        on_filter=SearchFilter(text="urlaubsantrag"),
        on_answer=AnswerOutput(answer_de="…", cited_ids=[]),
    )
    gateway = _make_gateway(documents=[])
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            await c.post(
                "/api/ai/answer", json={"question": "Was steht im Urlaubsantrag?"}
            )

    sent_params = gateway.search_documents.await_args.args[0]
    assert sent_params.get("query") == "urlaubsantrag"


async def test_answer_soft_fails_when_answer_llm_emits_invalid_schema(client_factory):
    """If the answer LLM produces JSON that pydantic can't validate (e.g. a
    small local model leaks a control token into a key name), the route must
    NOT 422 — it should still return 200 with the retrieved candidates as
    citations and a German "couldn't formulate an answer" message.
    """
    from pydantic import ValidationError

    app, _settings, transport = await _logged_in(client_factory)
    real_doc = _doc(
        17,
        title="Perso Aram",
        correspondent_id=12,
        document_type_id=5,
        custom_fields=[{"field": 9, "value": "Sicht auf den Personalausweis."}],
    )
    # Build a real ValidationError the same way the production path would see it.
    try:
        AnswerOutput.model_validate({"answer_<channel|>{": "broken"})
    except ValidationError as ve:
        bad_validation = ve

    backend = _ScriptedBackend(
        on_filter=SearchFilter(document_type=DocumentType.Ausweis),
        on_answer=bad_validation,
    )
    gateway = _make_gateway(
        document_types={"Ausweis": 5},
        documents=[real_doc],
        field_ids={"ai_summary_de": 9},
    )
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer",
                json={"question": "wie lange habe ich bei Kopfstand gearbeitet"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Retrieved candidates surface as citations so the user still sees docs.
    assert [c["id"] for c in body["citations"]] == [17]
    # Soft-failure message in German, not a stack trace / pydantic error blob.
    assert "nicht zuverlässig" in body["answer_de"]
    assert "Dokumente" in body["answer_de"]


async def test_answer_degenerate_text_falls_back_to_citations(client_factory):
    """When the LLM echoes the schema field name as the answer (a small-model
    failure mode), the route should treat it as a soft-fail: surface the
    retrieved docs and a German "couldn't formulate" message instead of
    showing the user the literal string `answer_de`.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram Keushgerian CV EN",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[
            {"field": 9, "value": "Lebenslauf — Frontend bei Kopfstand seit 2022."},
        ],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        on_answer=AnswerOutput(answer_de="answer_de", cited_ids=[]),
    )
    gateway = _make_gateway(
        documents=[cv_doc],
        field_ids={"ai_summary_de": 9},
    )
    # Tag the gateway so the SearchFilter("Lebenslauf") resolves to a real id
    # and the retrieval step does not short-circuit to empty results.
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer",
                json={"question": "Wie lange habe ich bei Kopfstand gearbeitet?"},
            )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The literal "answer_de" must never reach the user.
    assert body["answer_de"] != "answer_de"
    assert "nicht zuverlässig" in body["answer_de"]
    # The retrieved doc surfaces as a citation so the user can read the source.
    assert [c["id"] for c in body["citations"]] == [16]


async def test_answer_real_prose_with_no_cited_ids_still_surfaces_candidates(client_factory):
    """If the model writes a real answer but forgets to cite anything, fall
    back to the retrieved candidates — an answer without a source has no
    way for the user to verify it.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[{"field": 9, "value": "Frontend bei Kopfstand seit 2022."}],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        on_answer=AnswerOutput(
            answer_de="Du arbeitest seit 2022 bei Kopfstand.",
            cited_ids=[],  # forgot to cite
        ),
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer", json={"question": "Wo arbeite ich?"}
            )

    body = resp.json()
    # Real prose passes through; citations get backfilled from retrieval.
    assert "2022" in body["answer_de"]
    assert [c["id"] for c in body["citations"]] == [16]


async def test_answer_denial_returns_empty_citations(client_factory):
    """When the answer LLM uses the bake-baked denial template, the response
    must NOT back-fill citations from the retrieved set. Rendering source
    cards under "Ich konnte das nicht finden" was the reported failure mode
    — the SPA looked like it was lying about its own search.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[{"field": 9, "value": "Frontend bei Kopfstand."}],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        on_answer=AnswerOutput(
            answer_de="Ich konnte das in den Dokumenten nicht finden.",
            cited_ids=[],
        ),
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer", json={"question": "Wo arbeite ich?"}
            )

    body = resp.json()
    assert "nicht finden" in body["answer_de"]
    assert body["citations"] == []


async def test_answer_stream_emits_meta_chunks_and_final(client_factory):
    """Happy-path SSE stream: meta first, then chunk events for each delta,
    then a final event with citations resolved from inline `[Quelle: N]`.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        17,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[
            {"field": 9, "value": "Frontend bei Kopfstand seit 2022."}
        ],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        stream_chunks=[
            "Du arbeitest ",
            "seit 2022 bei Kopfstand. ",
            "[Quelle: 17]",
        ],
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer/stream",
                json={"question": "Wie lange habe ich bei Kopfstand gearbeitet?"},
            )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = _parse_sse(resp.text)
    event_names = [e[0] for e in events]
    # Required event ordering: meta first, ≥1 chunk, final last.
    assert event_names[0] == "meta"
    assert event_names[-1] == "final"
    assert event_names.count("chunk") == 3

    final = next(payload for name, payload in events if name == "final")
    # Stream prose stitched together verbatim.
    assert "Du arbeitest seit 2022 bei Kopfstand." in final["answer_de"]
    # Inline `[Quelle: 17]` resolved against the retrieved set.
    assert [c["id"] for c in final["citations"]] == [17]


async def test_answer_stream_no_results_short_circuits_to_friendly_message(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    backend = _ScriptedBackend(
        on_filter=SearchFilter(text="non-existent"),
        stream_chunks=[],  # would not even be invoked
    )
    gateway = _make_gateway(documents=[])
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer/stream", json={"question": "wo ist xyz"}
            )

    events = _parse_sse(resp.text)
    final = next(payload for name, payload in events if name == "final")
    # Friendly German fallback; no citations fabricated.
    assert "nicht" in final["answer_de"].lower() or "keine" in final["answer_de"].lower()
    assert final["citations"] == []
    # Stream LLM was never invoked since retrieval was empty.
    assert "stream" not in [c[0] for c in backend.calls]


async def test_answer_stream_backfills_citations_when_no_inline_marker(client_factory):
    """If the model writes prose but forgets the [Quelle: N] markers, the
    server backfills citations from the retrieval set so the UI always
    has at least one source card to render.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[{"field": 9, "value": "Frontend bei Kopfstand."}],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        stream_chunks=["Antwort ohne Zitat."],
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer/stream", json={"question": "Wo arbeite ich?"}
            )

    final = next(p for n, p in _parse_sse(resp.text) if n == "final")
    assert [c["id"] for c in final["citations"]] == [16]


async def test_answer_stream_denial_returns_empty_citations(client_factory):
    """Streaming counterpart of test_answer_denial_returns_empty_citations:
    when the streamed prose IS a denial, the final event must carry no
    citations even though the retrieval set is non-empty.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[{"field": 9, "value": "Frontend bei Kopfstand."}],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        stream_chunks=["Ich konnte das ", "in den Dokumenten nicht finden."],
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer/stream", json={"question": "Wo arbeite ich?"}
            )

    final = next(p for n, p in _parse_sse(resp.text) if n == "final")
    assert "nicht finden" in final["answer_de"]
    assert final["citations"] == []


async def test_answer_stream_degenerate_text_swaps_to_softfail(client_factory):
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[{"field": 9, "value": "Frontend."}],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        stream_chunks=["answer_de"],
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer/stream", json={"question": "?"}
            )

    final = next(p for n, p in _parse_sse(resp.text) if n == "final")
    assert final["answer_de"] != "answer_de"
    assert "nicht zuverlässig" in final["answer_de"]
    assert [c["id"] for c in final["citations"]] == [16]


async def test_answer_stream_handles_mid_stream_error(client_factory):
    """The stream yields some text, then the backend raises. The endpoint
    must not surface a 500 — it logs, replaces empty text with the soft-
    fail message (or keeps partial text), and emits a final event.
    """
    app, _settings, transport = await _logged_in(client_factory)
    cv_doc = _doc(
        16,
        title="Aram CV",
        correspondent_id=None,
        document_type_id=None,
        custom_fields=[{"field": 9, "value": "Frontend."}],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(tags=["Lebenslauf"]),
        stream_chunks=RuntimeError("ollama dead"),
    )
    gateway = _make_gateway(
        documents=[cv_doc], field_ids={"ai_summary_de": 9}
    )
    gateway.list_tags = AsyncMock(return_value={"Lebenslauf": 99})
    app.dependency_overrides[get_llm_backend] = lambda: backend
    app.dependency_overrides[get_answer_llm_backend] = lambda: backend
    app.dependency_overrides[get_paperless_gateway] = lambda: gateway

    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post(
                "/api/ai/answer/stream", json={"question": "?"}
            )

    assert resp.status_code == 200
    events = _parse_sse(resp.text)
    names = [n for n, _ in events]
    assert names[-1] == "final"
    final = next(p for n, p in events if n == "final")
    # No prose accumulated before the exception → soft-fail message lands.
    assert "nicht zuverlässig" in final["answer_de"]
    assert [c["id"] for c in final["citations"]] == [16]


def _parse_sse(body: str) -> list[tuple[str, dict]]:
    """Parse an SSE response into [(event_name, json_payload), ...].

    Records are separated by a blank line; within a record, `event:` and
    `data:` lines carry the type and JSON-encoded payload.
    """
    out: list[tuple[str, dict]] = []
    for record in body.split("\n\n"):
        if not record.strip():
            continue
        event_name = "message"
        data_payload = ""
        for line in record.split("\n"):
            if line.startswith("event:"):
                event_name = line.split(":", 1)[1].strip()
            elif line.startswith("data:"):
                data_payload += line.split(":", 1)[1].strip()
        if not data_payload:
            continue
        import json as _json

        out.append((event_name, _json.loads(data_payload)))
    return out


async def test_answer_503_when_paperless_token_unset(client_factory):
    # Bypass _logged_in (which forces PAPERLESS_API_TOKEN=dummy); we want the
    # gateway-not-configured path that 503s on /api/ai/*.
    app, _settings, transport = await client_factory(
        BOOTSTRAP_USERNAME="admin",
        BOOTSTRAP_PASSWORD="topsecret",
    )
    async with app.router.lifespan_context(app):
        async with AsyncClient(transport=transport, base_url="http://test") as c:
            await _login(c)
            resp = await c.post("/api/ai/answer", json={"question": "Hallo?"})
    assert resp.status_code == 503
