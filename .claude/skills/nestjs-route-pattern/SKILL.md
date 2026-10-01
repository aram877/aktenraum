---
name: nestjs-route-pattern
description: Use when adding or modifying any route in services/aktenraum-api (the NestJS BFF layer). Documents the controller/service/schemas layout, dependency injection, the gateway-error → HTTP-status mapping, the FastAPI-compatible error shape, CSRF middleware compatibility, the get-document-then-patch idiom, and the pg-mem test harness. Triggers when editing services/aktenraum-api/src/*/*.controller.ts, when creating a new endpoint area, or when investigating an HTTP 4xx/5xx that doesn't match the gateway's actual error.
---

# NestJS route pattern (aktenraum-api)

`aktenraum-api` is the BFF (Backend-For-Frontend) layer: a NestJS app running as
**ESM** (not CommonJS — `@aktenraum/core` is ESM-only, and mixing the two here
produced unresolvable dual-package hazards). Every endpoint follows the same
shape. This skill is the template.

---

## Directory layout

Routes are grouped by area under `services/aktenraum-api/src/`:

```
ai/
  ├─ ai.controller.ts   ← routes + HTTP concerns only
  ├─ ai.service.ts      ← business logic
  ├─ ai.schemas.ts      ← zod request/response shapes
  ├─ ai.module.ts       ← wiring
  ├─ retrieval.ts       ← RAG helpers (pure-ish, unit-tested)
  └─ prompt.ts          ← prompt assembly

inbox/
  ├─ inbox.controller.ts
  ├─ inbox.service.ts
  ├─ inbox.schemas.ts
  └─ inbox.module.ts
```

Convention: the controller does routing, auth guards, validation and status
codes. It never talks to Paperless directly. The service holds the logic and
takes the gateway as a constructor dependency, which is what makes it testable
without HTTP.

---

## The standard controller

```ts
@Controller("inbox")
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  @UseGuards(AuthGuard)
  async list(
    @Query(new ZodValidationPipe(inboxListQuerySchema)) query: InboxListQuery,
  ): Promise<InboxListResponse> {
    return this.inboxService.list(query);
  }

  @Post(":doc_id/approve")
  @UseGuards(AuthGuard)
  async approve(
    @Param("doc_id", ParseIntPipe) docId: number,
    @Body(new ZodValidationPipe(inboxPatchSchema)) body: InboxPatch,
  ): Promise<InboxDetail> {
    return this.inboxService.approve(docId, body);
  }
}
```

Rules:

- **`@UseGuards(AuthGuard)` on every route that touches user data.** The only
  unguarded routes are `/api/health`, `/api/auth/*`, and the secret-gated
  internal `/api/settings/active-*` pair.
- **Validate with zod through `ZodValidationPipe`**, never by hand. A failed
  parse becomes a 422 with the same body shape FastAPI produced, so the SPA's
  error handling did not have to change during the migration.
- **Return the response type explicitly.** There is no OpenAPI codegen step in
  the Nuxt SPA; its hand-written interfaces in `apps/web/app/{composables,utils}/*.ts`
  mirror these shapes, so a shape change must be made on both sides.

---

## Global prefix, ordering, and middleware

`main.ts` does, in this exact order:

```ts
await applySchema(settings.DATABASE_URL);   // must precede NestFactory.create
const app = await NestFactory.create(AppModule, { bufferLogs: false });
app.setGlobalPrefix("api");
app.use(cookieParser());
app.use(securityHeadersMiddleware);
app.use(csrfMiddleware);
app.useGlobalFilters(new FastApiErrorShapeFilter());
```

The order matters:

- `applySchema` runs **before** Nest boots. Module `onModuleInit` hooks query
  `users` and `auto_approve_rules`; on a fresh database those tables do not
  exist yet and the app dies with `Failed query: select "id" from "users"`.
- `cookieParser` must precede the CSRF middleware and the auth guard — both
  read `req.cookies`.
- The exception filter is global and last so nothing bypasses the error shape.

---

## Error shape and gateway-error mapping

`FastApiErrorShapeFilter` re-shapes **every** error to `{ "detail": "..." }`.
That is FastAPI's shape, kept deliberately: the SPA reads `detail` everywhere,
and changing it would have turned a backend migration into a frontend one.

Paperless errors map to HTTP statuses in one place:

| Gateway error              | HTTP | When                                              |
| -------------------------- | ---- | ------------------------------------------------- |
| `PaperlessNotFoundError`   | 404  | document / entity id does not exist                |
| `PaperlessConflictError`   | 409  | lifecycle-tag swap lost all three retries          |
| `PaperlessAuthError`       | 502  | token rejected — an operator problem, not a user's |
| `PaperlessError` (generic) | 502  | anything else upstream                             |

**Never** let a raw upstream status reach the client. A Paperless 401 surfacing
as a 401 would make the SPA log the user out, when the real problem is a stale
`PAPERLESS_API_TOKEN` on the server.

If `PAPERLESS_API_TOKEN` is unset entirely, `PaperlessGatewayProvider.require()`
throws and the area returns 503 while `/api/health` and `/api/auth/*` stay
green. That distinction is intentional: the app is reachable, one capability
is not.

---

## CSRF compatibility

`csrfMiddleware` rejects state-changing methods (and `/preview` + `/download`)
when `Sec-Fetch-Site: cross-site` is present. Internal callers — the worker's
webhook, Paperless's `post_consume` — bypass it by sending
`X-Aktenraum-Secret`. See ADR-003. Any new internal-to-internal endpoint must
send that header or it will be blocked in a browser-adjacent context.

---

## The get-document-then-patch idiom

Paperless replaces the **whole** `custom_fields` array on PATCH — it is not a
partial upsert. Sending only `{ai_correspondent: …}` wipes the other eleven
fields. Every field write therefore goes:

```ts
const doc = await gateway.getDocument(docId);      // read current array
const merged = mergeCustomFields(doc, updates);    // merge by field id
await gateway.patchDocumentCustomFields(docId, merged);
```

The same is true of `tags`. `swapLifecycleTag` plans the full target array and
writes it once, with a three-attempt verify-and-retry for the TOCTOU race.

---

## Tests

`src/test/harness.ts` builds a real Nest app over **pg-mem** plus a stateful
fake Paperless gateway, driven with supertest. That means route tests exercise
guards, pipes, the exception filter and the real service code — no mocking of
the layer under test.

Two things that will bite you:

- **`vitest.config.ts` uses `unplugin-swc`, not esbuild.** esbuild drops
  `emitDecoratorMetadata`, so Nest's DI resolves every injected dependency to
  `undefined` and every route 500s with no useful message. If you see that,
  check the transform, not your module wiring.
- **pg-mem rejects `rowMode` and `types`** from node-postgres. The harness
  wraps the client to strip them (`withArrayRowModeSupport`). A new query style
  that trips this shows up as an opaque driver error.

Adding a route means adding a route test. The harness makes it cheap; there is
no excuse for an untested endpoint.

---

## Checklist for a new endpoint

1. ☐ Controller method with `@UseGuards(AuthGuard)` unless deliberately public
2. ☐ zod schema for params/query/body, wired through `ZodValidationPipe`
3. ☐ Logic in the service, not the controller
4. ☐ Gateway errors left to propagate — the filter maps them
5. ☐ Explicit return type
6. ☐ Route test against the harness covering success + the auth failure
7. ☐ If it writes custom fields or tags: read-merge-write, never a bare PATCH
