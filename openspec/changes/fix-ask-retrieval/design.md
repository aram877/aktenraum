## Decisions

**RAG first, then decide.** Structured search and RAG are independent signals; the empty short-circuit only makes sense when both are empty. The `meta` event still reports the structured `total`.

**Slot order.** Reranked chunks are the highest-precision signal for body questions, and there are at most `rerankTopK` (5) distinct RAG documents, so putting them first costs at most 5 of 15 slots while guaranteeing their chunks reach the model. Structured results fill the rest in their native order.

**Filter parity.** `vectorFilterFor` derives the Qdrant filter from the broadened filter. The Qdrant payload stores Paperless's native correspondent name, so an LLM guess is mapped case-insensitively onto `listCorrespondents()`; no match → no correspondent constraint (mirrors `executeFilter`, which moves an unknown correspondent into full-text). If the filtered search returns no chunks and a constraint was applied, one unfiltered search follows (`rag_retrieve_unfiltered_fallback`); the reranker decides relevance.

**Citation pool = prompt.** Anything else lets a hallucinated id pass because it happened to be in the unseen structured set.

**Partial totals.** `computeTypeAggregations` receives the structured `total`; when it exceeds the number of prompt candidates the heading says the sum covers only the listed documents and drops "direkt als Antwort verwenden".

**Delimiters, not sanitisation.** Wrapping plus an explicit rule is the standard mitigation for indirect prompt injection; the answer model has no tools, so the residual risk is a manipulated answer, and citations are still id-checked.
