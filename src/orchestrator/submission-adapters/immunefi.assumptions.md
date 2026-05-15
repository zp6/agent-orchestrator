# ImmunefiAdapter — assumptions

This file is the Phase A/B promotion record for the Immunefi submission adapter.
See `docs/adapter-discipline.md` for the format specification and dispatcher gate
rules.

---

## External dependencies

| Assumption | Verified? | Evidence |
|------------|-----------|----------|
| `api.immunefi.com` resolves and is reachable from fleet infra | ❌ no | — |
| `/v1/submissions` accepts POST with Bearer auth | ❌ no | — |
| Response body contains `submission_id` field | ❌ no | — |
| Bearer token scope covers submission creation (not read-only) | ❌ no | — |
| Rate-limit headers follow standard `Retry-After` convention | ❌ no | — |
| Immunefi sandbox / staging endpoint exists for pre-production testing | ❌ no | — |

## Phase

- **Current:** A (stubbed)
- **Promote to B when:** all six assumptions above are `✅ yes` with evidence links

## Unblocking work

1. Provision `IMMUNEFI_API_TOKEN` (blocked on fleet holding a verified Immunefi account).
2. Run `curl -I https://api.immunefi.com` from a fleet container — confirm DNS resolves
   and TLS handshake succeeds.
3. Send a test POST to `/v1/submissions` with a dummy payload — confirm HTTP 401
   (auth required) or 400 (bad body), not 404 (endpoint absent).
4. With a valid token, send a minimal POST — confirm response includes `submission_id`.
5. Check response headers for rate-limit conventions.
6. Ask Immunefi support whether a sandbox environment exists. If not, note that
   in the evidence column and mark the assumption `✅ yes` with that explanation.
7. Update each row above to `✅ yes` with a link or description of the evidence.
8. Change `Current: A` to `Current: B`.
9. The dispatcher gate will then allow go-live dispatch.

## History

| Date | Event |
|------|-------|
| 2026-05-15 | Phase A/B ritual landed (issue #1645). Adapter is Phase A. |
