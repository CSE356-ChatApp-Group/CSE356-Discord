# =============================================================================
# ChatApp API – multi-stage Dockerfile
#
# Build:   docker build -t chatapp-api .
# Run:     docker run -p 3000:3000 --env-file .env chatapp-api
# =============================================================================

# ── Stage 1: dependencies ──────────────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# ── Stage 2: production image ──────────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Non-root user for security
RUN addgroup -S chatapp && adduser -S chatapp -G chatapp

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Compile TypeScript before pruning dev dependencies
RUN npm run build

# Remove dev tooling from final image
RUN npm prune --omit=dev
# Tini for proper signal handling in containers
RUN apk add --no-cache tini

USER chatapp

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "dist/index.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/health || exit 1
