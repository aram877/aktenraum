---
name: aktenraum-commit-discipline
description: Use BEFORE any git commit or push on the aktenraum repo. Documents the project-specific commit rules from CLAUDE.md (never commit before running tests locally; never commit after a bug fix without user confirmation), the binding documentation cadence (session note at docs/sessions/YYYY-MM-DD.md, ADR at docs/adr/NNN-name.md for architectural decisions, CLAUDE.md update in the same commit), and the commit-message conventions. Triggers when the user says "commit", "push", "save my work", when finishing implementation work, or when planning a multi-step change that should be committed in pieces.
---

# aktenraum commit discipline

This repo has stricter commit rules than most. They exist because the project ships to non-technical buyers (per ADR-002) — a bug pushed silently to `main` becomes a bug in someone's installer in the next release cycle. Read this BEFORE any commit.

---

## Rule 1 — never commit before tests pass locally

From the bottom of CLAUDE.md:

> NEVER EVER commit anything before running tests locally..

This is non-negotiable. Before any commit:

```bash
uv run ruff check
uv run pytest
```

If you touched the SPA, also:

```bash
pnpm --filter @aktenraum/web lint
pnpm --filter @aktenraum/web build
```

CI runs the same checks (`.github/workflows/ci.yml`), but if you commit broken code, CI is the wrong place to find out — you've already polluted `main`'s history with a fix-up commit. Run locally first.

If a test fails because of your change, **fix the test or the code first**, don't push and "fix in next commit." Same goes for ruff/eslint errors. `--no-verify` is forbidden unless the user explicitly asks for it.

---

## Rule 2 — never commit after a bug fix without user confirmation

From the bottom of CLAUDE.md:

> NEVER EVER commit after fixing a bug without me first confirming that the bug is fixed

A passing test suite is necessary but **not sufficient** for a bug fix. The user needs to verify the fix on a real document / real workflow before you commit. Tests cover correctness of the code; they can't cover "does this actually solve the user's problem."

Procedure:

1. Implement the fix.
2. Run lint + tests.
3. Tell the user:
   - What changed (one-paragraph summary, file refs).
   - How to verify on real data (specific command, what to look for in logs / UI).
   - That you'll wait for confirmation before committing.
4. If the user explicitly says "push" / "commit" / "ship it" → that IS the confirmation. Note the override in the session doc so future sessions can audit.
5. Otherwise: stop. Wait. Use the time to look for follow-ups, not to commit.

This rule has an explicit user-override path because sometimes the user can't verify immediately (no docs to test against right now, the fix is to a path they'll exercise tomorrow). When the user says "push anyway" — push, but flag in the commit message and the session doc that the live verification was deferred.

---

## Rule 3 — documentation cadence is binding

From CLAUDE.md:

> Every working session ends with a session summary at `docs/sessions/YYYY-MM-DD.md`. Architectural decisions go to `docs/adr/NNN-name.md`. Multi-phase initiatives go to `docs/plans/<topic>.md`. Whenever a session changes any of these (new feature, new gotcha, new constraint, finished phase), CLAUDE.md is updated in the same commit so future sessions see current state without trawling git log.

In practice this means **every non-trivial commit includes**:

- The code change.
- An entry (new file or appended section) in `docs/sessions/<today>.md` describing what shipped and why.
- A new ADR if the change makes a binding architectural decision (e.g. "we'll use SameSite=Lax + Sec-Fetch-Site for CSRF defence" — that was ADR-003).
- Updated CLAUDE.md if the change adds a new gotcha, removes an old one, finishes a roadmap phase, or changes the "what's implemented vs planned" table.

The session doc covers, in order:

1. **Focus / scope** — one sentence: what this session set out to do.
2. **Repo state** — branch, commits ahead of previous push, test counts pre/post.
3. **What shipped** — grouped by area (Security, Bugs, Performance, …), each item links specific files and commit messages.
4. **Diagnosed but not fixed** — anything investigated but deferred. Why.
5. **Pick up next session** — concrete TODOs, one sentence each.
6. **Roadmap progress** — which plan in `docs/plans/` advanced; which phase is now done.

For multi-commit sessions (today happens to be one — three commits between morning and afternoon), append a "Follow-up commit" section rather than starting a new session file. Same day = same session note.

---

## Rule 4 — commit message conventions

Look at recent commits for the shape:

```bash
git log --oneline -10
```

Format: `<type>(<scope>): <summary>`

- **type**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`.
- **scope**: `tagger`, `api`, `web`, `taskfile`, `all` (cross-cutting), `settings`, etc. Service or area name.
- **summary**: imperative, no period, under ~70 chars.

The body (heredoc) covers:

- What changed (bullets per area).
- Why (the user-visible problem this fixes).
- Test status (e.g. "475 tests pass, ruff clean").
- Co-author trailer.

The co-author trailer is required:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Use a heredoc to pass the multi-line message so formatting survives:

```bash
git commit -m "$(cat <<'EOF'
fix(tagger): summary lands empty when small model drops it

Add _synthesize_summary_de fallback wired after extraction.
Mirrors the existing ai_title / confidence_reason pattern.

475 tests pass; ruff clean.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Rule 5 — destructive operations need explicit user authorization

From CLAUDE.md (paraphrased from the general system rules):

- Force push to `main`/`master`: never without explicit request, warn the user even when asked.
- `git reset --hard` on a branch with uncommitted work: ask first.
- `git push --force`: ask first; suggest `--force-with-lease`.
- `git branch -D` on a branch other than your current feature branch: ask first.
- Skipping hooks (`--no-verify`, `--no-gpg-sign`): never unless the user explicitly asks; if a hook fails, fix the underlying issue.

This is the "blast radius" lens. A wrong commit can be amended; a wrong force push can erase teammates' work.

---

## Rule 6 — staging is explicit, not `git add .`

From CLAUDE.md system rules:

> When staging files, prefer adding specific files by name rather than using "git add -A" or "git add .", which can accidentally include sensitive files (.env, credentials) or large binaries

Standard flow:

```bash
git status --short
# review the list, then stage explicitly:
git add path/to/file1.py path/to/file2.py docs/new-doc.md
git status --short  # confirm the right set is staged
git commit -m "..."
```

The repo's `.gitignore` covers most secrets (`docker/*.env`, `pgdata/`, etc.), but new files in untracked directories can slip through `git add -A`. Stage by name.

---

## Rule 7 — pull requests use `gh pr create`, with summary + test plan

If pushing to a branch other than `main` for review, use `gh pr create`:

```bash
gh pr create --title "Concise title under 70 chars" --body "$(cat <<'EOF'
## Summary
- bullet 1
- bullet 2

## Test plan
- [ ] uv run pytest
- [ ] manual verify: <specific user flow>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL when done.

---

## The pre-commit checklist (copy-paste in your head before every commit)

1. ☐ `uv run ruff check` — green
2. ☐ `uv run pytest` — green (count tests so the session doc has the new total)
3. ☐ SPA-touched? `pnpm --filter @aktenraum/web build` — green
4. ☐ Bug fix? User confirmed it works on real data, OR explicit "push anyway"?
5. ☐ Session doc updated for today?
6. ☐ ADR written if this is a binding architectural decision?
7. ☐ CLAUDE.md updated if this changes gotchas / status / constraints?
8. ☐ `git status --short` — only the intended files staged?
9. ☐ Commit message follows `type(scope): summary` + heredoc body + co-author trailer?

If all eight are ☑, commit. If any is ☐, stop and complete it first.

---

## When the user says "push"

Treat it as authorization for the commit + push, but **not** as a waiver of the checklist. The checklist still runs; only the bug-fix-confirmation rule is overridden. Mention in the session doc that the live-verify was deferred at user request.

If the user says "push" without having tested:

```
Pushing now per your request. Bug-fix-confirmation rule normally requires
live verification first; flagged in the session doc. Rollback is one
`git revert <hash>`. The fix passes all 475 tests; failure mode would be
"synthesised summary reads wrong on your actual docs" rather than "code
crashes." Quick verify path: <specific command>.
```

That's the right shape: do as asked, surface the rule, leave the user a one-line rollback path.

---

## Don't

- Don't `git add -A` or `git add .` blindly.
- Don't `git commit --amend` after pushing — it rewrites history. Create a new commit instead.
- Don't pass `--no-verify` to skip pre-commit hooks. Fix the hook failure.
- Don't push to `main` from a half-done state with a "fix in next commit" plan.
- Don't write commit messages without a body — for non-trivial changes, the body is where the *why* lives.
- Don't forget the co-author trailer.
- Don't commit a bug fix and assume tests = confirmation. Tests are necessary, not sufficient.
- Don't skip the session doc. It's the only artifact future sessions can read to understand what happened today.
