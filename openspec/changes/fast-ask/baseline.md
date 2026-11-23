# Ask latency baseline (before fast-ask)

Measured 2026-11-23 on the live stack with the `ask_timing` build, 10 questions twice (round 1 "cold", round 2 "warm"), via the SPA endpoint `/api/ai/answer/stream`. Models: filter `gemma4:26b`, answer `qwen2.5:14b-instruct-q8_0`, reranker on. Times in ms from request start.

Every question swaps the two models in Ollama, so "warm" is not faster than "cold".

| Stage | min | median | max |
| --- | --- | --- | --- |
| parse (filter LLM) | 10 329 | 14 580 | 24 591 |
| retrieve (Paperless search + embed + Qdrant + rerank), cumulative | 13 797 | 20 828 | 45 483 |
| enrich (per-document Paperless calls), cumulative | 13 905 | 33 022 | 47 547 |
| first answer token | 19 961 | 40 585 | 55 439 |
| total | 20 965 | 41 728 | 57 437 |

Client-side time to first chunk equals server `first_token_ms` (nothing streams earlier; there is no `sources` event yet).

## Per question (total ms, candidates, cited ids)

| Question | cold | warm | candidates | answer (before) |
| --- | --- | --- | --- | --- |
| Wie viel habe ich 2025 für Strom bezahlt? | 52 142 | 43 083 | 15 | 1.582,91 € (cold) vs 2.664,83 € (warm): not stable |
| Wann läuft meine Kfz-Versicherung ab? | 28 655 | 29 340 | 3 | 04.09.2026 |
| Was war meine letzte Gehaltsabrechnung? | 48 683 | 46 926 | 15 | Dezember 2022 |
| Welche Rechnungen habe ich letztes Jahr von Amazon bekommen? | 32 172 | 28 862 | 3 | "2020" (filter LLM treats "letztes Jahr" as 2020) |
| Wie hoch ist meine Miete? | 50 371 | 49 887 | 4 | 363,90 € kalt… (cold); "nicht gefunden" (warm) |
| Welche Verträge habe ich gekündigt? | 26 318 | 44 671 | 4 | Kündigungen Arbeitsverhältnis, Stromvertrag |
| Wann war mein letzter Arztbrief? | 24 846 | 26 308 | 2 | 09.04.2025 |
| Wie lange war ich bei meinem letzten Arbeitgeber beschäftigt? | 57 439 | 53 168 | 15 | u+i interact GmbH & Co. KG… |
| Welche Steuerbescheide habe ich bekommen? | 41 733 | 40 244 | 4 | 2023, 2024, 2025 |
| Gibt es Mahnungen? | 21 740 | 20 965 | 1 | Mahnung 14,90 € |

Observations: the filter LLM alone costs 10–25 s per question (model swap), and its guesses make answers unstable ("Miete" found once, not found once; "letztes Jahr" = 2020). The answer model needs another 6–9 s from the end of enrichment to the first token.

## After

Measured 2026-11-23 after the rewrite (live stack, same 20 requests, `OLLAMA_ANSWER_NUM_CTX=12288`, `RERANK_CANDIDATES=20`). Server-side `ask_timing`, ms, cumulative from request start:

| Stage | min | median | max | before (median) |
| --- | --- | --- | --- | --- |
| parse (no LLM) | 1 | 1 | 92 | 14 580 |
| retrieve (embed + Qdrant + rerank, parallel with Paperless) | 5 131 | 6 544 | 8 138 | 20 828 |
| candidates loaded (`sources` sent here) | 5 411 | 6 770 | 8 454 | 33 022 |
| first answer token | 7 419 | 8 419 | 14 925 | 40 585 |
| total | 8 106 | 9 230 | 16 169 | 41 728 |

Where the remaining time goes (`rag_retrieve_complete`): embed 20-30 ms, Qdrant 5 ms, **rerank 5-6.5 s on the CPU for 20 chunks**; the answer model needs 1.2-2.3 s from `sources` to the first token. The spec target "sources in < 1 s warm" is not met while the CPU reranker runs; options: `RERANK_CANDIDATES=10`, lower `RERANK_MAX_TOKENS`, or `RERANKER_ENABLED=false`.

Tuning notes: at `OLLAMA_ANSWER_NUM_CTX=24576` the answer model (19.9 GB) and the embedder cannot both stay in 24 GB VRAM and Ollama swapped them on every question (17-20 s). 8192 fits but real prompts reach 7.1-8.1k tokens (Ollama log), too tight; 12288 keeps both loaded (answer 17.4 GB + embedder 3.4 GB at `num_ctx` 4096).

### Answer comparison (warm round, before vs after)

| Question | before | after | verdict |
| --- | --- | --- | --- |
| Strom 2025 | 2.664,83 € (cold run 1.582,91 €) | 2.269,69 € (861,60 + 1.408,09) | both unstable; after shows the parts |
| Kfz-Versicherung | 04.09.2026 | 04.10.2026 | after looks wrong (check doc 32) |
| letzte Gehaltsabrechnung | Dezember 2022 | Oktober 2026 (doc 276) | after better |
| Amazon letztes Jahr | "2020" | "2020", three invoices | same (no 2025 Amazon invoices; semantic path answers) |
| Miete | not found | 1.296,08 € | after better (source label is odd: "Dokumente der Art Rechnung") |
| gekündigte Verträge | Strom, Arbeitsverhältnis, Girokonto | not found | **regression** |
| letzter Arztbrief | 09.04.2025 | 28.03.2022 | **regression** ("letzte" is not ordered newest-first when semantic hits fill the slots) |
| letzter Arbeitgeber | 2021-01-15 bis 2026-12-31 | same | same |
| Steuerbescheide | 2023, 2024, 2025 | two for 2025 plus more | partly worse |
| Mahnungen | Mahnung 14,90 € | same | same |
