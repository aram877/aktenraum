# Spec Delta

## Purpose

Turns a member's natural-language question into a streamed German answer grounded in, and citing, the documents that member may see. Latency is minimal: no LLM runs before retrieval.

## ADDED Requirements

### Requirement: Retrieval without a filter LLM
The Ask endpoint SHALL select answer candidates without calling an LLM before the answer call. Candidates come from semantic chunk search and Paperless full-text search over the question, optionally narrowed by structured hints parsed deterministically from the question.

#### Scenario: Only one LLM call per question
- **WHEN** a member asks any question
- **THEN** exactly one LLM request is made (the streamed answer), and no filter-extraction request is made

#### Scenario: Document not yet in the vector index
- **WHEN** a question's answer lives in a document that Paperless full-text search finds but that has no chunks in the vector index (e.g. still pending review)
- **THEN** that document is still offered to the answer model as a candidate

#### Scenario: Vector index unavailable
- **WHEN** the vector store or the embedder fails or is disabled
- **THEN** the answer is built from the Paperless full-text and structured candidates alone, and the request does not fail

### Requirement: Deterministic question parsing
The system SHALL extract structured hints from the question without an LLM: date ranges (a year, "letztes Jahr", a month with a year), document types (via the German intent keywords), and correspondents whose known name appears in the question. Parsed hints only narrow structured search. They SHALL NOT remove semantic or full-text candidates.

#### Scenario: Year in the question
- **WHEN** the question is "Wie viel Strom habe ich 2025 bezahlt?"
- **THEN** the parsed hints contain the date range 2025-01-01 to 2025-12-31

#### Scenario: Known correspondent named
- **WHEN** the question mentions "Vattenfall" and a correspondent named "Vattenfall Europe Sales GmbH" exists
- **THEN** the parsed hints contain that correspondent

#### Scenario: No recognisable hints
- **WHEN** the question contains no date, type keyword or known correspondent
- **THEN** retrieval runs on semantic and full-text search only, and the answer is still produced

### Requirement: Sources are streamed before the answer
The stream SHALL send a `sources` event with the candidate documents of the prompt before the first answer token. The order is `meta`, `sources`, one or more `chunk`, then `final` (or `error` at any point). `final` keeps its fields `answer_de`, `citations` and `total`.

#### Scenario: Event order
- **WHEN** a member asks a question that has matching documents
- **THEN** the client receives `meta`, then `sources` listing those documents, then `chunk` events, then `final`

#### Scenario: Nothing found
- **WHEN** no retrieval path returns a candidate
- **THEN** the client receives `meta`, an empty `sources`, the German "nicht gefunden" answer as a `chunk`, and `final` with empty citations

### Requirement: Citations limited to prompt candidates
Citations in `final` SHALL only reference documents that were sent in `sources`. Inline `[Quelle: <id>]` markers naming any other id SHALL be dropped. When the model cites nothing and the answer is not a denial, the citations are the `sources` documents. A denial answer has no citations.

#### Scenario: Hallucinated citation id
- **WHEN** the answer text contains `[Quelle: 9999]` and document 9999 was not in `sources`
- **THEN** document 9999 is not in `final.citations`

### Requirement: Tenancy scoping on every retrieval path
Every candidate, from semantic search, full-text search or structured search, SHALL be limited to documents the asking member may read: home space, active share, or unassigned documents for the household admin only. Trashed documents SHALL never be candidates.

#### Scenario: Other member's private document
- **WHEN** member A asks a question whose best match is a document in member B's personal space that is not shared with A
- **THEN** that document appears in neither `sources` nor `citations`, and its content is not in the prompt

### Requirement: Answer model stays loaded
Answer requests to Ollama SHALL ask the server to keep the model resident (`OLLAMA_KEEP_ALIVE`, default indefinitely). They SHALL use the answer-specific context size `OLLAMA_ANSWER_NUM_CTX`, which defaults to `OLLAMA_NUM_CTX` so a model shared with extraction is not reloaded. The settings page SHALL warn when the extraction and answer models differ.

#### Scenario: Second question is warm
- **WHEN** a member asks two questions within ten minutes with no other model loaded in between
- **THEN** the second answer request causes no model load in Ollama

#### Scenario: Different models configured
- **WHEN** the extraction model and the answer model in `/settings` are different tags
- **THEN** the LLM settings section shows a hint that both cannot stay loaded at once and Ask will be slower

### Requirement: Per-stage timing is logged
Each Ask request SHALL log one `ask_timing` event with the milliseconds for parsing, retrieval, candidate loading, time to the first answer token and the total. It also logs the number of candidates and whether reranking ran. It SHALL NOT log the question text.

#### Scenario: Timing event
- **WHEN** an Ask request completes
- **THEN** exactly one `ask_timing` log line with those fields is written

