# aktenraum — architecture diagrams

Portfolio-ready diagrams of the aktenraum stack in three text formats. Pick one:

- **Mermaid** — renders natively on GitHub, GitLab, Notion, Obsidian, Docusaurus, MkDocs-Material. Best default.
- **D2** ([d2lang.com](https://d2lang.com)) — nicer auto-layout; needs the `d2` CLI or a plugin to render.
- **ASCII** — zero tooling, drops into any monospace block.

---

## Mermaid — system architecture (topology + data flow)

```mermaid
flowchart TB
    user(["👤 User / Browser"])
    llm{{"LLM backend<br/>Ollama (local) or Anthropic API"}}
    mail[["📧 IMAP mailbox<br/>(opt-in ingestion)"]]

    subgraph edge["Edge"]
        nginx["nginx<br/>:8080<br/>serves SPA static + proxies /api/*"]
    end

    subgraph app["Application layer (local builds)"]
        api["aktenraum-api (FastAPI)<br/>:8002<br/>auth · AI find/ask · RAG retrieval · inbox/library"]
        tagger["auto-tagger (asyncio workers)<br/>:8001 internal<br/>extraction · propagation · RAG indexer"]
    end

    subgraph paperless_grp["Paperless-ngx core"]
        paperless["paperless-ngx<br/>:8000<br/>DMS · OCR · consume pipeline"]
        gotenberg["gotenberg<br/>PDF conversion"]
        tika["tika<br/>document parsing"]
    end

    subgraph data["Data stores"]
        pg[("postgres<br/>paperless DB + aktenraum DB")]
        redis[("redis<br/>task queue")]
        qdrant[("qdrant<br/>vector store<br/>chunks + payload")]
    end

    backup["backup<br/>crond + restic, daily 02:00"]

    user -->|HTTPS| nginx
    nginx -->|"/api/*"| api
    nginx -->|"static SPA"| user

    api -->|REST + token| paperless
    api -->|RAG search + rerank| qdrant
    api -->|filter + answer prompts| llm
    api --> pg

    mail -.->|attachments| paperless
    paperless --> gotenberg
    paperless --> tika
    paperless --> pg
    paperless --> redis
    paperless -->|"post_consume webhook"| tagger

    tagger -->|extraction prompt| llm
    tagger -->|"PATCH ai_* fields + lifecycle tags"| paperless
    tagger -->|"chunk → embed (bge-m3) → upsert"| qdrant
    tagger -.->|"auto-approve rules (HTTP)"| api

    backup -.->|"snapshots: data/media/export + 2 DB dumps"| pg
```

## Mermaid — document lifecycle (sequence)

```mermaid
sequenceDiagram
    actor U as User
    participant P as paperless-ngx
    participant T as auto-tagger
    participant L as LLM
    participant API as aktenraum-api
    participant Q as qdrant

    U->>P: Upload document (via SPA → /api/documents/upload)
    P->>P: OCR + consume pipeline
    P->>T: post_consume webhook → /trigger/extract
    T->>L: classify + extract (27-type taxonomy)
    L-->>T: DocumentExtraction (Pydantic-validated)
    T->>P: PATCH 12 ai_* fields + lifecycle tag

    alt confidence ≥ per-type min AND rule enabled
        T->>P: ai-approved + ai-auto-approved
    else needs review
        T->>P: ai-pending
        U->>API: Review in inbox → approve
        API->>P: swap ai-pending → ai-approved
    end

    Note over T: propagation watcher (polls ai-approved)
    T->>P: write native correspondent/type/date/tags → ai-propagated
    T->>Q: chunk → embed → upsert (RAG index)

    U->>API: "Ask AI" question
    API->>Q: hybrid retrieve + rerank (bge-reranker-v2-m3)
    API->>L: answer prompt + retrieved chunks
    L-->>API: German prose answer + [Quelle: id] citations
    API-->>U: SSE token stream + citation cards
```

---

## D2 — system architecture

```d2
user: 👤 User / Browser {shape: person}
llm: LLM backend\nOllama (local) or Anthropic API {shape: hexagon}
mail: 📧 IMAP mailbox\n(opt-in) {shape: page}

edge: Edge {
  nginx: nginx :8080\nSPA static + proxy /api/*
}

app: Application layer (local builds) {
  api: aktenraum-api (FastAPI) :8002\nauth · AI find/ask · RAG · inbox/library
  tagger: auto-tagger (asyncio) :8001\nextraction · propagation · indexer
}

paperless_core: Paperless-ngx core {
  paperless: paperless-ngx :8000\nDMS · OCR · consume
  gotenberg: gotenberg\nPDF conversion
  tika: tika\ndocument parsing
}

data: Data stores {
  pg: postgres\npaperless + aktenraum DBs {shape: cylinder}
  redis: redis\ntask queue {shape: cylinder}
  qdrant: qdrant\nvector store {shape: cylinder}
}

backup: backup\ncrond + restic daily 02:00

user -> edge.nginx: HTTPS
edge.nginx -> app.api: /api/*
edge.nginx -> user: static SPA

app.api -> paperless_core.paperless: REST + token
app.api -> data.qdrant: RAG search + rerank
app.api -> llm: filter + answer prompts
app.api -> data.pg

mail -> paperless_core.paperless: attachments {style.stroke-dash: 3}
paperless_core.paperless -> paperless_core.gotenberg
paperless_core.paperless -> paperless_core.tika
paperless_core.paperless -> data.pg
paperless_core.paperless -> data.redis
paperless_core.paperless -> app.tagger: post_consume webhook

app.tagger -> llm: extraction prompt
app.tagger -> paperless_core.paperless: PATCH ai_* fields + lifecycle tags
app.tagger -> data.qdrant: chunk -> embed (bge-m3) -> upsert
app.tagger -> app.api: auto-approve rules (HTTP) {style.stroke-dash: 3}

backup -> data.pg: snapshots: data/media/export + 2 DB dumps {style.stroke-dash: 3}
```

---

## ASCII — system architecture

```
                              👤 User / Browser
                                      │ HTTPS
                                      ▼
                          ┌───────────────────────┐
                          │  nginx  :8080          │  ◀── EDGE
                          │  SPA static + /api/*   │
                          └───────────┬───────────┘
                                      │ /api/*
                                      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  APPLICATION (local builds)                                        │
   │                                                                    │
   │   ┌──────────────────────────┐      ┌───────────────────────────┐ │
   │   │ aktenraum-api (FastAPI)   │◀────▶│ auto-tagger (asyncio)     │ │
   │   │ :8002                     │ rules│ :8001 internal            │ │
   │   │ auth · find/ask · RAG     │      │ extraction · propagation  │ │
   │   │ · inbox · library         │      │ · RAG indexer             │ │
   │   └───┬────────┬─────────┬────┘      └───┬───────────┬───────────┘ │
   └───────┼────────┼─────────┼───────────────┼───────────┼─────────────┘
           │        │         │               │           │
           │        │         │  ┌────────────┘           │
   prompts │  RAG   │  REST   │  │  webhook                │ extraction
           ▼        │  +token │  ▼  (post_consume)         │ prompt
     ┌───────────┐  │         │ ┌──────────────────────┐   │
     │ LLM       │  │         └▶│ paperless-ngx :8000   │◀──┘ PATCH ai_*
     │ Ollama or │  │           │ DMS · OCR · consume   │     + lifecycle
     │ Anthropic │  │           └──┬───────┬────────┬───┘
     └───────────┘  │              │       │        │
                    │         ┌────┘    ┌──┘     ┌──┘
                    │         ▼         ▼        ▼
                    │   ┌──────────┐ ┌────────┐ ┌────────────┐
                    │   │ gotenberg│ │ tika   │ │ (📧 IMAP)  │
                    │   │ PDF conv │ │ parse  │ │ opt-in     │
                    │   └──────────┘ └────────┘ └────────────┘
                    │
   DATA STORES      ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  ╔════════════╗   ╔════════════╗   ╔═══════════════════════════╗   │
   │  ║ postgres   ║   ║ redis      ║   ║ qdrant                    ║   │
   │  ║ paperless+ ║   ║ task queue ║   ║ vector store (chunks)     ║   │
   │  ║ aktenraum  ║   ╚════════════╝   ╚═══════════════════════════╝   │
   │  ╚═════╤══════╝                                                    │
   └────────┼───────────────────────────────────────────────────────────┘
            │ daily 02:00
            ▼
     ┌─────────────────────────────────┐
     │ backup (crond + restic)         │
     │ data/media/export + 2 DB dumps  │
     └─────────────────────────────────┘
```

---

## Mermaid — simplified (non-technical audience)

Five boxes, no ports, no internals. Good for a portfolio landing section.

```mermaid
flowchart LR
    user(["📄 You drop in a<br/>document"])
    app["aktenraum<br/>(web app)"]
    ai{{"AI reads &<br/>understands it"}}
    store[("Organised,<br/>searchable archive")]
    ask(["💬 Ask questions<br/>in plain language"])

    user --> app
    app --> ai
    ai -->|"sorts, labels,<br/>files automatically"| store
    store --> ask
    ask -->|"answers with<br/>sources"| user

    classDef accent fill:#2563eb,stroke:#1e40af,color:#fff;
    classDef soft fill:#eff6ff,stroke:#bfdbfe,color:#1e3a8a;
    class app,ai accent;
    class store,user,ask soft;
```

---

## Mermaid — C4 Level 1 (System Context)

Who and what talks to the system, nothing about the internals.

```mermaid
C4Context
    title aktenraum — System Context

    Person(user, "User", "Files personal documents, reviews AI suggestions, asks questions")

    System(aktenraum, "aktenraum", "Self-hosted DMS with an AI classification + retrieval layer")

    System_Ext(llm, "LLM backend", "Local Ollama or Anthropic API — classification, extraction, answers")
    System_Ext(mail, "IMAP mailbox", "Optional: forwards attachments for ingestion")

    Rel(user, aktenraum, "Uploads, reviews, searches", "HTTPS")
    Rel(aktenraum, llm, "Prompts for extraction & answers", "HTTP/API")
    Rel(mail, aktenraum, "Sends attachments", "IMAP poll")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

## Mermaid — C4 Level 2 (Container)

The deployable units and what each one does.

```mermaid
C4Container
    title aktenraum — Container View

    Person(user, "User", "Browser / mobile")

    System_Ext(llm, "LLM backend", "Ollama or Anthropic")
    System_Ext(mail, "IMAP mailbox", "Optional ingestion")

    Container_Boundary(edge, "Edge") {
        Container(nginx, "nginx", "nginx", "Serves the SPA, reverse-proxies /api/*")
    }

    Container_Boundary(app, "Application") {
        Container(spa, "Web SPA", "React + TanStack", "Inbox, library, find, ask, upload, scan")
        Container(api, "aktenraum-api", "Python / FastAPI", "Auth, AI find/ask, RAG retrieval, inbox & library")
        Container(tagger, "auto-tagger", "Python / asyncio", "Extraction, propagation, RAG indexing")
    }

    Container_Boundary(core, "Paperless-ngx core") {
        Container(paperless, "paperless-ngx", "Django", "DMS, OCR, consume pipeline")
        Container(gotenberg, "gotenberg", "Service", "PDF conversion")
        Container(tika, "tika", "Service", "Document parsing")
    }

    ContainerDb(pg, "postgres", "PostgreSQL", "paperless + aktenraum databases")
    ContainerDb(redis, "redis", "Redis", "Paperless task queue")
    ContainerDb(qdrant, "qdrant", "Qdrant", "RAG vector store: chunks + payload")
    Container(backup, "backup", "restic + cron", "Daily snapshots: files + 2 DB dumps")

    Rel(user, nginx, "Uses", "HTTPS")
    Rel(nginx, spa, "Serves")
    Rel(nginx, api, "Proxies /api/*")

    Rel(api, paperless, "REST + token")
    Rel(api, qdrant, "Search + rerank")
    Rel(api, llm, "Filter & answer prompts")
    Rel(api, pg, "Reads/writes")

    Rel(mail, paperless, "Attachments")
    Rel(paperless, gotenberg, "Converts")
    Rel(paperless, tika, "Parses")
    Rel(paperless, pg, "Persists")
    Rel(paperless, redis, "Queues")
    Rel(paperless, tagger, "post_consume webhook")

    Rel(tagger, llm, "Extraction prompts")
    Rel(tagger, paperless, "PATCH ai_* fields + tags")
    Rel(tagger, qdrant, "Embed + upsert chunks")
    Rel(tagger, api, "Fetch auto-approve rules")

    Rel(backup, pg, "Dumps")

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="2")
```

---

## Legend / key

Shapes and lines are consistent across every diagram above.

**Shapes**

| Shape | Meaning | Examples |
| --- | --- | --- |
| Rounded box / person `( )` | A human actor | User / Browser |
| Hexagon `{{ }}` | External system you don't run | LLM backend (Ollama / Anthropic) |
| Page / sheet `[[ ]]` | External data source feeding in | IMAP mailbox |
| Plain rectangle `[ ]` | A service you deploy (a Docker container) | nginx, aktenraum-api, paperless-ngx |
| Cylinder `[( )]` | A datastore / persistent volume | postgres, redis, qdrant |
| Subgraph box | A logical tier | Edge · Application · Paperless core · Data |

**Lines**

| Line | Meaning |
| --- | --- |
| Solid arrow `──▶` | Primary runtime call / data flow, always on |
| Dashed arrow `--▶` | Optional or background flow (opt-in mail ingestion, config fetch, scheduled backup) |
| Arrow label | The protocol or payload (`HTTPS`, `REST + token`, `post_consume webhook`, …) |

**Mermaid legend block** (paste alongside a diagram if you want it inline on the page):

```mermaid
flowchart LR
    a(["Person"]) -.- b{{"External system"}}
    c["Service / container"] -.- d[("Datastore")]
    e["A"] -->|"always-on flow"| f["B"]
    g["C"] -.->|"optional / background"| h["D"]
```

---

## Caption notes (for the portfolio write-up)

- **10 services, all Docker** — edge (nginx), app (two Python services), Paperless core (3), data (3 stores), plus a backup sidecar.
- **Why two Python services** — process isolation, independent memory caps and restart cadence (see `docs/adr/004-two-python-services.md`).
- **Event-driven, not polling-first** — the `post_consume` webhook drives extraction; a 30s poller is only a safety net.
- **Local-first AI** — classification + RAG (bge-m3 embeddings, bge-reranker-v2-m3 cross-encoder rerank) run on a local Ollama by default; Anthropic is a drop-in backend.
- **Corrections become signal** — approved/edited extractions feed few-shot exemplars and per-correspondent history hints, so accuracy improves without retraining a model.
```
