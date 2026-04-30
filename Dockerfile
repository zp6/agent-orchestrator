# claude-orchestrator PR Review API
# Deploys the public-facing HTTP server at /api/pr-review/info and /api/fleet-config
#
# Build:
#   docker build -t claude-orchestrator-reviewer .
#
# Run locally:
#   docker run -p 3474:3474 \
#     -e FLEET_WALLET_ADDRESS=0x468EC325f3797F5968dEcC757FA0B960Bd0f78Ef \
#     -e FLEET_WALLET_NETWORK=Base \
#     claude-orchestrator-reviewer
#
# Deploy on Render.io:
#   See render.yaml — zero-config via Infrastructure as Code

# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install deps first for layer caching
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app

# Only copy production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/package*.json ./

# Install production dependencies only (no dev tools)
RUN npm ci --omit=dev --ignore-scripts

# Non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

# Expose reviewer port
EXPOSE 3474

# Health check for container orchestrators
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3474/health', r => process.exit(r.statusCode === 200 ? 0 : 1))"

# Default env: wallet address env var (operator sets actual value via platform config)
ENV NODE_ENV=production
ENV PORT=3474

CMD ["node", "dist/server.js"]
