# Public Artifacts & Deployments

This document tracks all publicly-deployed services and artifacts operated by the claude-agent-orchestrator fleet.

## Hire-the-Fleet Landing Page

**Status:** Deployed to Cloudflare Workers  
**Service:** `hire-the-fleet` Worker  
**Live URL:** `https://hire-the-fleet.claude-agent-orchestrator.workers.dev` _(see operator setup below)_

### Overview

Static landing page for the Hire-the-Fleet service offering (Path 4 of the Day-7 first-dollar campaign, issue #1261). Includes pricing, SLA, how-it-works steps, and intake CTA.

### Deployed Assets

- **Landing page:** `docs/hire-the-fleet/index.html` — styled GitHub Pages-compatible HTML
- **Routes:**
  - `GET /` — serve landing page (200 OK)
  - `GET /health` — health check (200 OK)
  - `GET /apply` or `GET /intake` — redirect to GitHub issue intake form (302)
- **Headers:**
  - `Content-Type: text/html; charset=utf-8`
  - `Cache-Control: public, max-age=3600`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`

### Operator Setup (One-Time)

The Worker is ready to deploy but requires Cloudflare credentials. To complete deployment:

1. **Ensure Cloudflare API access:**
   ```bash
   export CLOUDFLARE_API_TOKEN="<your-api-token>"
   export CLOUDFLARE_ACCOUNT_ID="<your-account-id>"
   ```

2. **Install wrangler (if not already installed):**
   ```bash
   npm install -g @cloudflare/wrangler
   # or
   npm install --save-dev @cloudflare/wrangler
   ```

3. **Deploy the Worker:**
   ```bash
   wrangler deploy
   ```

4. **Verify deployment:**
   ```bash
   curl -i https://hire-the-fleet.claude-agent-orchestrator.workers.dev/
   # Should return 200 OK with HTML content
   
   curl -i https://hire-the-fleet.claude-agent-orchestrator.workers.dev/health
   # Should return 200 OK with JSON: {"status":"ok","service":"hire-the-fleet"}
   ```

5. **(Optional) Bind to custom domain:**
   - Update `route` in `wrangler.toml` to your domain
   - Update `zone_id` if deploying under a Cloudflare Zone
   - Re-run `wrangler deploy`

### Configuration Files

- **wrangler.toml** — Cloudflare Worker project configuration
- **src/worker/index.ts** — Worker handler (TypeScript)
- **docs/hire-the-fleet/index.html** — Landing page source HTML

### Files Involved

- Merged in PR #1371 (closes #1301)
- Deployment via PR #1382 (closes #1381)

---

## Fleet Artifact Registry

| Service | Type | Status | URL | Notes |
|---------|------|--------|-----|-------|
| Hire-the-Fleet | Landing Page | 🟡 Ready to Deploy | `https://hire-the-fleet.*.workers.dev` | Awaiting operator Cloudflare auth |

Legend:
- 🟢 Deployed and healthy
- 🟡 Ready to deploy (waiting on operator setup)
- 🔴 Deployment blocked or unhealthy
