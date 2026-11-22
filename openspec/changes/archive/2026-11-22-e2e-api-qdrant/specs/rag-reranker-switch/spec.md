# Spec Delta

## Purpose

How the api can run RAG retrieval and every Qdrant payload write without the cross-encoder reranker, so a memory-capped test stack can exercise the real vector-store paths.

## ADDED Requirements

### Requirement: The reranker can be switched off
The api SHALL read a boolean setting `RERANKER_ENABLED`, defaulting to `true`. When it is `false` and `QDRANT_URL` is set, the api SHALL NOT construct, download, load or prewarm the reranker model, and SHALL log `reranker_disabled` once at startup. Every other use of the vector store (retrieval, trash flags, share and space payload writes) SHALL work as with the reranker enabled.

#### Scenario: default keeps the reranker
- **WHEN** the api starts with `QDRANT_URL` set and `RERANKER_ENABLED` unset
- **THEN** the reranker is prewarmed and retrieval reranks candidates, exactly as before

#### Scenario: reranker disabled
- **WHEN** the api starts with `QDRANT_URL` set and `RERANKER_ENABLED=false`
- **THEN** no reranker model is loaded, `reranker_disabled` is logged, and Ask still retrieves chunks from Qdrant

### Requirement: Retrieval without a reranker keeps the dense order
When no reranker is configured, retrieval SHALL return the first `RAG_RERANK_TOP_K` Qdrant hits in Qdrant's order with Qdrant's scores, SHALL NOT log a rerank failure, and SHALL report `reranker_used: false` in `rag_retrieve_complete`. With a reranker, `rag_retrieve_complete` SHALL report `reranker_used: true` unless the rerank failed and fell back to dense order.

#### Scenario: no reranker
- **WHEN** a question is asked with the reranker disabled and Qdrant returns 20 hits
- **THEN** the top 5 hits in Qdrant's order are used, and no `rag_retrieve_rerank_failed` is logged

#### Scenario: reranker fails
- **WHEN** the reranker throws
- **THEN** the same dense order is used, `rag_retrieve_rerank_failed` is logged, and `reranker_used` is `false`

### Requirement: The e2e api writes to the e2e Qdrant
The throwaway e2e stack SHALL run the api with the e2e Qdrant URL and key and `RERANKER_ENABLED=false`, and its rehearsals SHALL assert the api's own payload writes: `shared_with` after a share grant and revoke, `space_id` right after a member removal, and `trashed` after moving a document to the trash and restoring it.

#### Scenario: trash flag in the e2e run
- **WHEN** the e2e run moves its indexed document to the trash
- **THEN** every chunk of that document carries `trashed: true` within 10 seconds, and after a restore `trashed: false`
