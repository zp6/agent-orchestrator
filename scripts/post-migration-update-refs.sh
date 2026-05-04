#!/usr/bin/env bash
#
# post-migration-update-refs.sh
#
# Run this script from the agent-orchestrator repo root AFTER the GitHub org
# transfer (rapartlu → nexus-fleet) is complete. It replaces every occurrence
# of "rapartlu/" with "nexus-fleet/" in source files, config, and documentation.
#
# Usage:
#   bash scripts/post-migration-update-refs.sh
#
# Dry-run (no changes made):
#   DRY_RUN=1 bash scripts/post-migration-update-refs.sh
#
# IMPORTANT: Review `git diff` carefully after running before committing.
# Some rapartlu refs are human-identity references (reviewer handles, PR
# escalation checks) that need manual attention — see MANUAL_REVIEW_REQUIRED
# below.
#
# Tracking issue: https://github.com/rapartlu/agent-orchestrator/issues/1470

set -euo pipefail

OLD_ORG="rapartlu"
NEW_ORG="nexus-fleet"
DRY_RUN="${DRY_RUN:-0}"

log() { echo "[post-migration] $*"; }
warn() { echo "[post-migration] ⚠️  WARNING: $*" >&2; }

# Files/patterns explicitly EXCLUDED from replacement because they contain
# references to rapartlu as a human GitHub handle (not as an org path), or
# are historical fixtures that should not be changed.
#
# These require manual review — see MANUAL_REVIEW_REQUIRED section below.
EXCLUDE_PATTERNS=(
  "--add-reviewer rapartlu"
  "r.login === \"rapartlu\""
  "rapartlu (the Operator)"
  "rapartlu@"
)

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1 — will show matches but not modify files"
fi

# ─── Target file sets ──────────────────────────────────────────────────────────

# Config and top-level docs
TOP_LEVEL_FILES=(
  "agents.yaml"
  "CLAUDE.md"
  "ROADMAP.md"
  "RESOURCES.md"
  "CHARTER.md"
  "MISSION.md"
  "SEVERANCE.md"
  "WORKFLOW.md"
)

do_replace() {
  local file="$1"
  if [[ ! -f "$file" ]]; then return; fi

  # Count matches first
  local count
  count=$(grep -c "$OLD_ORG/" "$file" 2>/dev/null || echo 0)
  if [[ "$count" -eq 0 ]]; then return; fi

  log "  → $file ($count matches)"

  if [[ "$DRY_RUN" != "1" ]]; then
    # BSD sed (macOS) requires '' after -i; GNU sed accepts it too
    sed -i '' "s|${OLD_ORG}/|${NEW_ORG}/|g" "$file"
  fi
}

# ─── Top-level files ───────────────────────────────────────────────────────────

log "Processing top-level files..."
for f in "${TOP_LEVEL_FILES[@]}"; do
  do_replace "$f"
done

# ─── Source files ─────────────────────────────────────────────────────────────

log "Processing src/**/*.ts ..."
while IFS= read -r -d '' file; do
  do_replace "$file"
done < <(find src -name "*.ts" -print0)

# ─── Documentation ────────────────────────────────────────────────────────────

log "Processing docs/**/*.md ..."
while IFS= read -r -d '' file; do
  do_replace "$file"
done < <(find docs -name "*.md" -print0)

# ─── Scripts ──────────────────────────────────────────────────────────────────

log "Processing scripts/**/*.{sh,ts,mjs} ..."
while IFS= read -r -d '' file; do
  do_replace "$file"
done < <(find scripts -name "*.sh" -o -name "*.ts" -o -name "*.mjs" -print0)

# ─── GitHub workflows ─────────────────────────────────────────────────────────

log "Processing .github/workflows/**/*.yml ..."
while IFS= read -r -d '' file; do
  do_replace "$file"
done < <(find .github -name "*.yml" -o -name "*.yaml" -print0 2>/dev/null || true)

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
log "Replacement pass complete."
if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN mode — no files modified. Remove DRY_RUN=1 to apply changes."
else
  log "Run 'git diff' to review all changes before committing."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "MANUAL REVIEW REQUIRED"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The following lines contain 'rapartlu' as a HUMAN IDENTITY reference"
echo "(not as an org path). They were NOT automatically replaced and need"
echo "manual decisions:"
echo ""

MANUAL_FILES=(
  "src/orchestrator/pr-reviewer.ts"
  "src/orchestrator/pr-lister.ts"
)

for f in "${MANUAL_FILES[@]}"; do
  if [[ -f "$f" ]]; then
    echo "  $f:"
    grep -n "rapartlu" "$f" 2>/dev/null | sed 's/^/    /' || true
    echo ""
  fi
done

echo "These patterns need manual decisions:"
echo "  1. '--add-reviewer rapartlu' (pr-reviewer.ts ~line 602)"
echo "     → Replace with fleet GitHub App bot username once App is registered (RESOURCES.md #1)"
echo "     → Or remove if human escalation is no longer in scope post-severance"
echo ""
echo "  2. 'r.login === \"rapartlu\"' (pr-lister.ts ~line 124)"
echo "     → Replace with per-agent App bot login check once App is registered"
echo "     → This is the escalation-to-human detection; update to match new reviewer identity"
echo ""
echo "  3. Historical issue refs in src/triggers/seed-antibodies.ts:"
echo "     → GitHub redirects will handle these automatically — safe to leave as-is"
echo "     → Or update to nexus-fleet/ refs for consistency (no functional impact)"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "After manual review: git add -A && git commit -m 'chore: migrate refs to nexus-fleet org'"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
