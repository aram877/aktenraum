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
            "ai_due_date": None,
            "ai_expiry_date": "2034-02-27",
            "ai_monetary_amount": None,
            "ai_reference_numbers": "L01XYZ",
        }
    ]
    msgs = build_answer_messages("Wann läuft mein Pass ab?", candidates=candidates)
    user = _user(msgs)
    assert "Dokument 17" in user
    assert "Perso Aram" in user
    assert "2034-02-27" in user
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
            "ai_due_date": None,
            "ai_expiry_date": None,
            "ai_monetary_amount": "EUR99.00",
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


# ---- Router tests ----


class _ScriptedBackend:
    """Returns scripted outputs in order based on the response_schema requested.

    The answer endpoint makes two LLM calls: filter extraction (SearchFilter)
    then answer generation (AnswerOutput). Map by schema so the tests stay
    declarative without coupling to call order.
    """

    def __init__(
        self,
        *,
        on_filter: SearchFilter,
        on_answer: AnswerOutput | Exception | None = None,
    ) -> None:
        self._on_filter = on_filter
        self._on_answer = on_answer
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
    gateway._monetary_field_id = (field_ids or {}).get("ai_monetary_amount")
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
        "ai_expiry_date": 5,
        "ai_monetary_amount": 6,
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
            {"field": 5, "value": "2034-02-27"},
        ],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(document_type=DocumentType.Ausweis),
        on_answer=AnswerOutput(
            answer_de="Dein Personalausweis läuft am 27.02.2034 ab.",
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
    assert "27.02.2034" in body["answer_de"]
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
            {"field": 5, "value": "2034-02-27"},
            {"field": 9, "value": "Personalausweis ausgestellt 2024-02-28."},
        ],
    )
    backend = _ScriptedBackend(
        on_filter=SearchFilter(
            document_type=DocumentType.Ausweis, text="verlängern"
        ),
        on_answer=AnswerOutput(
            answer_de="Dein Personalausweis läuft am 27.02.2034 ab.",
            cited_ids=[17],
        ),
    )
    gateway = _make_gateway(
        document_types={"Ausweis": 5},
        documents=[perso],
        field_ids={"ai_expiry_date": 5, "ai_summary_de": 9},
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
