# Build stage — production deps only, from the lockfile.
FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Runtime stage
FROM node:22-slim
ARG BUILD_GIT_VERSION=dev
ARG BUILD_GIT_COMMIT=none
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="Discord Assistant"
LABEL org.opencontainers.image.description="One Discord bot reaching an OpenAI-compatible endpoint from text and voice"
LABEL org.opencontainers.image.vendor="Benjamin Borbe"
LABEL org.opencontainers.image.source="https://github.com/bborbe/discord-assistant"
LABEL org.opencontainers.image.version="${BUILD_GIT_VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${BUILD_GIT_COMMIT}"

WORKDIR /app

COPY --from=builder /app/node_modules /app/node_modules
COPY package.json ./
COPY src/ ./src/

ENV NODE_ENV=production
ENV BUILD_GIT_VERSION=${BUILD_GIT_VERSION}
ENV BUILD_GIT_COMMIT=${BUILD_GIT_COMMIT}
ENV BUILD_DATE=${BUILD_DATE}

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://localhost:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# exec node directly so PID 1 receives SIGTERM and graceful shutdown works.
ENTRYPOINT ["node", "src/index.js"]

EXPOSE 8080
