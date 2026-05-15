# Adapter discipline — Phase A/B promotion ritual

Tracks the convention that every submission adapter (and any other integration
that talks to an external API) must make its assumptions explicit and must not
be dispatched into production without those assumptions being verified.

---

## Problem this solves

ImmunefiAdapter's docstring was honest: *"Phase A — the fleet does not yet hold
an `IMMUNEFI_API_TOKEN`."* What failed was that promotion from Phase A to Phase
B was implicit. The standup synthesised a go-live action (issue #1639) without
anyone checking whether the Phase A assumptions had actually been verified. This
document makes the promotion ritual explicit so that gap cannot recur.

---

## `assumptions.md` format

Every adapter ships alongside an `assumptions.md` file. The file lives next to
the adapter source file:

```
src/orchestrator/submission-adapters/
  immunefi.ts             # adapter implementation
  immunefi.assumptions.md # this file
  types.ts
```

For adapters that live outside `submission-adapters/`, the file lives in the
same directory as the adapter. The naming convention is `<adapter>.assumptions.md`.

### Required sections

```markdown
# <AdapterName> — assumptions

## External dependencies

| Assumption | Verified? | Evidence |
|------------|-----------|----------|
| <human-readable statement> | ✅ yes / ❌ no | <URL or description> |

## Phase

- **Current:** A / B
- **Promote to B when:** <list of what must be true>

## Unblocking work (Phase A only)

1. <first thing to verify>
2. <second thing, etc.>
```

### Rules

- Every row in the `External dependencies` table must have a `Verified?` cell
  that is either `✅ yes` or `❌ no`. Partial values (e.g. `⚠️ partial`) are
  treated as `❌ no` by the gate.
- **Current phase** must be the literal string `A` or `B`. Any other value is
  treated as `A` (fail-safe default).
- A file that claims `Phase B` but has any `❌ no` rows is a discipline
  violation. The gate rejects go-live dispatch and files a finding.
- A missing `assumptions.md` is treated as Phase A. There is no implicit Phase B.

---

## Phase definitions

| Phase | Meaning | Go-live allowed? |
|-------|---------|-----------------|
| A | Stubbed. Real external calls either return a stub error or are absent. The adapter compiles and tests pass, but no live traffic has hit the external endpoint. | No |
| B | Wired. All assumptions in the table are verified with evidence. The adapter has been tested end-to-end against the real endpoint at least once. | Yes |

---

## Dispatcher gate

The orchestrator's pre-dispatch validator applies the Phase A/B gate to any
issue whose title or body matches a go-live pattern:

- "provision token"
- "enable production"
- "go live" / "go-live"
- "launch production"
- "deploy production"
- "promote to Phase B"

When a go-live pattern matches and the issue references a known adapter:

1. The validator reads the adapter's `assumptions.md`.
2. If the file is missing: **blocked** (treated as Phase A, no file means no discipline).
3. If the file shows Phase A: **blocked** — rejection names the unverified assumptions.
4. If the file claims Phase B but has `❌ no` rows: **blocked** — rejection names
   the discipline violation.
5. If the file shows Phase B with all rows `✅ yes`: **allowed**.

The rejection message is structured. Example:

```
phase_promotion_gate: immunefi adapter is Phase A — 3 unverified assumption(s):
  - `api.immunefi.com` resolves and is reachable
  - `/v1/submissions` accepts POST with Bearer auth
  - Response body contains `submission_id` field
Verify these before dispatching a go-live task.
```

The unblocking work (verifying each assumption) becomes the priority task instead
of the go-live dispatch.

---

## Auditor surface

The daily audit pass reads every `assumptions.md` file in the fleet and surfaces:

1. **Phase A drift** — adapters stuck in Phase A for more than N days without
   any change to their assumptions table. Signals work is stalled.
2. **Lie signal** — adapters claiming Phase B with `❌ no` rows. Immediate
   finding, treated as a discipline violation.
3. **Missing discipline** — adapters with no `assumptions.md` file at all.
   Filed as a gap each day until resolved.

---

## Worked example

See `src/orchestrator/submission-adapters/immunefi.assumptions.md` for a
complete Phase A example. The file captures the exact state of the Immunefi
integration as of the Phase A/B ritual landing (2026-05-15).

When the Immunefi token is provisioned and the endpoint verified, update each
row to `✅ yes`, add evidence links, and change `Current: A` to `Current: B`.
That is the promotion ritual. It takes five minutes. It prevents the next #1642.
