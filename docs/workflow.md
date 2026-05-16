# How aktenraum works — the plain-English walkthrough

This is the "follow one document through the system" guide. No jargon. If something here uses a term you don't know, [`docs/glossary.md`](glossary.md) defines every acronym we use.

The deeper architectural reference is in [`docs/architecture.md`](architecture.md). This file is the friendly version.

---

## The cast of services

There are eight services that always run together. Each does exactly one job:

| Service | Job in one line |
| --- | --- |
| **nginx** | The front door. Serves the website and forwards `/api/*` calls to aktenraum-api. |
| **SPA** (the website) | What you see in the browser. Buttons, lists, the inbox. Doesn't talk to Paperless directly — only to aktenraum-api. |
| **aktenraum-api** | The trusted middleman. Holds the Paperless password, checks your login, exposes friendly endpoints to the website. |
| **Paperless** | The file cabinet. Stores the PDF, runs OCR, holds metadata. The boring-but-load-bearing piece. |
| **auto-tagger** | The AI worker. Watches Paperless for new files; calls the LLM to extract data; later writes the approved data back. |
| **Postgres** | The database. Holds Paperless's metadata + a small aktenraum table for users and settings. |
| **Qdrant** | The smart search index. Stores searchable embeddings of every paragraph for "ask the AI" questions. |
| **Ollama / Anthropic** | The brain. The LLM that reads documents and answers questions. |

(There are two more containers — `redis`, `tika`, `gotenberg`, `backup` — but they're Paperless's helpers and the backup cron. You don't interact with them.)

---

## Journey 1 — you drop a PDF on the upload page

Concrete example: a bill from Stadtwerke München arrives in the mail. You scan it and drag it into the upload page.

1. **Browser**: you drag the file onto `/upload`. The SPA shows a progress bar.
2. **nginx**: receives `POST /api/documents/upload`, forwards it to aktenraum-api.
3. **aktenraum-api**: checks your login cookie, checks the file is ≤25 MB and a real PDF, then streams it to Paperless using the Paperless API token (which never leaves the server).
4. **Paperless**: stores the file, runs OCR (turns the PDF into searchable text), saves the text in its database. Returns a "task id" so we can track when OCR finishes.
5. **Paperless** then fires a **webhook** — a small HTTP call to the auto-tagger saying *"document 42 just landed, please look at it."*
6. **auto-tagger**: puts the document id on its work queue.

What you see in the upload page: `Bereit → Wird hochgeladen → Paperless verarbeitet… → KI klassifiziert… → ✓ in der Inbox`.

---

## Journey 2 — the AI does its thing (no human involved)

7. **auto-tagger's worker** picks document 42 off the queue:
   - Reads the OCR'd text from Paperless.
   - Builds a German prompt: *"You are a document classification assistant. Here is the text. Tell me the type, sender, date, summary, etc."* It also adds a hint like *"this sender has historically been Rechnung type 9/10 times"* if it recognises the correspondent.
   - Sends the prompt to the LLM (Ollama on your machine, or Anthropic in the cloud — your choice in Settings).
   - The LLM returns structured JSON: `{document_type: "Rechnung", correspondent: "Stadtwerke München", issue_date: "2024-03-15", summary: "…", confidence: 0.87, …}`.
   - Saves all 12 AI fields onto the document in Paperless (`ai_correspondent`, `ai_document_type`, `ai_summary_de`, …).
   - Tags the document `ai-pending` — meaning *"waiting for the human to review"*.

The document now appears in your **Review queue** (`/library?tab=review`) with the AI's guesses pre-filled.

> **What if the small LLM drops fields?** Smaller models (≤8B) sometimes leave `ai_title`, `summary_de`, `confidence_reason`, or `reference_numbers` empty. The auto-tagger has *post-extraction safety nets*: it synthesises a sensible title / summary / reason from the structured fields when the LLM didn't, and a regex sweep over the OCR text harvests common German reference numbers (Aktenzeichen, Rechnungsnr., …) the LLM missed. End result: those fields are never empty even on small models.

---

## Journey 3 — you approve it

8. **You** open the review queue, look at the AI's guesses, maybe fix one ("the LLM read the date wrong, it should be 2024-03-12"), and click **Approve**.
9. **Browser → aktenraum-api**: `POST /api/inbox/42/approve` with your edits.
10. **aktenraum-api**: writes your edits back to Paperless's `ai_*` fields, then swaps the tag from `ai-pending` to `ai-approved`.
11. **auto-tagger's propagator loop** (running every 30 seconds in the background) sees `ai-approved`:
    - Copies the AI fields onto Paperless's **native** fields (the ones Paperless itself uses: `correspondent`, `document_type`, `created_date`, `tags`). This is what makes the doc show up properly in Paperless's own search.
    - Swaps the tag from `ai-approved` to `ai-propagated` — meaning *"done."*
    - Hands the document id to the **indexer loop**.
12. **indexer loop**:
    - Chops the OCR'd text into ~500-word paragraphs.
    - Sends each paragraph to a special small AI model (`bge-m3`) that turns text into a list of numbers (an "embedding") representing its meaning.
    - Saves all the embeddings + the paragraph text into Qdrant.

The document is now fully filed, with native Paperless metadata, and its content is searchable by meaning (not just by keywords).

---

## Journey 4 — you ask "Wann ist meine Stromrechnung fällig?"

This is the "Ask AI" page. It's a two-step pipeline.

13. **Browser**: SPA sends `POST /api/ai/answer/stream` to aktenraum-api with the question.
14. **aktenraum-api** — step A, *finding the right documents*:
    - Sends the question to a small LLM with a prompt: *"Extract a structured filter from this question."* The LLM returns `{document_type: "Rechnung", text: "Strom"}`.
    - Asks Paperless: *"Give me bills matching this filter."* Gets back, say, 8 documents.
    - Also asks Qdrant: *"Find paragraphs whose meaning is close to 'Wann ist meine Stromrechnung fällig?'"* Gets back the 5 most relevant paragraphs across the corpus.
15. **aktenraum-api** — step B, *answering*:
    - Builds a new prompt: *"Here are 8 candidate documents and 5 relevant paragraphs. Answer the user's question in German and cite the doc ids you used."*
    - Sends it to a bigger LLM (the "answer model" you picked in Settings).
    - The LLM streams its answer back word by word.
16. **aktenraum-api** forwards every word to the browser as a stream of events (this is what *Server-Sent Events / SSE* is).
17. **Browser**: shows the answer appearing live, character by character, with clickable citation cards at the bottom for each doc the AI used.

---

## The two background loops that never stop

While you're doing anything (or nothing), the auto-tagger has **two timers** running:

- **Every 30 seconds — the poller**: *"Paperless, any documents I haven't classified yet?"* Catches anything the webhook missed (auto-tagger restarted, network blip, etc.). Belt-and-suspenders.
- **Every 30 seconds — the propagator**: *"Any documents tagged `ai-approved`?"* Copies their data to native fields, marks them `ai-propagated`. Catches docs you approve while the propagator was busy on something else.

Both are **idempotent** — running them twice on the same doc does nothing the second time. That's important: it means a crash mid-pipeline never corrupts the doc's state.

---

## Who's responsible for what — one-line summary

| Layer | What it does | What it doesn't do |
| --- | --- | --- |
| **You** | Upload, review, approve, ask questions | Touch the database, run scripts, manage secrets |
| **nginx** | Routing, request-size limits, security headers | Hold any application logic |
| **SPA** | Render the UI, collect your input, show the answer | Talk to Paperless directly, touch any secret |
| **aktenraum-api** | Auth, request validation, building LLM prompts, streaming answers, holding the Paperless token | Run OCR, store files, do classification |
| **Paperless** | File storage, OCR, the document's "official" metadata | Anything AI-related |
| **auto-tagger** | The only thing that calls the LLM for classification; runs poll, propagate, index loops | Serve HTTP to users |
| **Postgres** | Durable storage for everyone | Make decisions |
| **Qdrant** | Fast "search by meaning" lookups | Store the original PDF |
| **Ollama / Anthropic** | The actual brain that reads text and writes JSON or prose | Anything else |

---

## The lifecycle tags — a doc's "status"

Every document carries one of these as its current state. You can see them in the UI as little badges.

```
(no tag)      → just uploaded, AI hasn't looked yet
ai-pending    → AI extracted data, waiting for human review     ← in the Inbox
ai-approved   → you approved, propagator hasn't run yet         ← transient (≤30s)
ai-rejected   → you rejected, no propagation will happen
ai-propagated → fully filed, native fields written              ← final success
ai-error      → AI extraction crashed; clear tags to retry
ai-propagation-error → AI ok but native-fields write failed
```

That tag is the **single source of truth** for "where is this doc in the pipeline". Every workflow above is just code that watches for one tag and produces another.

Two auxiliary markers that live alongside, not instead:

- `ai-auto-approved` — pinned permanently to docs the AI was so confident about that they skipped the review queue. The UI renders "Auto-genehmigt" wherever you see one.
- `ai-low-confidence` — pinned to docs in the review queue where the AI flagged itself as uncertain. The UI puts them at the top of the queue.

---

## What happens when something goes wrong

| Failure | What happens | What you do |
| --- | --- | --- |
| LLM is down / times out | doc gets tagged `ai-error`, error message stored on the doc | Click "Erneut verarbeiten" — the auto-tagger picks it up again. |
| OCR fails or returns empty text | doc gets tagged `ai-error` | The PDF is probably an image with no text. Re-scan with OCR-friendly settings. |
| You approve, but writing native fields fails (Paperless rejected the value) | doc gets tagged `ai-propagation-error`, error stored | Fix the offending field on the doc, click "Erneut verarbeiten". |
| Qdrant is down | indexing of new docs pauses; existing answers still work but only with metadata, no paragraph search | Restart the qdrant container; run `task rag:backfill` if you skipped indexing for a while. |
| auto-tagger container crashes | docs queue up in Paperless tagged with nothing | On restart, the poller scans and picks them all up within 30s. No work lost. |
| You quit Docker Desktop mid-extraction | the in-flight extraction is cancelled; the doc stays with no AI tags | On next start, the poller finds it and re-extracts. The propagator's PATCH is *shielded* against cancellation so it never leaves a doc half-propagated. |

---

## The mental model in two sentences

> aktenraum is **Paperless plus an AI layer that watches Paperless and writes back to Paperless**. The website talks to a thin "trusted middleman" called aktenraum-api which holds the secrets and proxies to Paperless on your behalf — you never see Paperless's token, and Paperless never sees the AI.

Everything else is just plumbing.
