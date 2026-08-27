# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS web-builder

WORKDIR /build/web
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
RUN pnpm build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=18084 \
    DB_PATH=/app/data/extension.sqlite \
    PUBLIC_DIR=/app/web/dist

WORKDIR /app/server
COPY --chown=node:node server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node server/src ./src
COPY --chown=node:node server/scripts ./scripts
COPY --from=web-builder --chown=node:node /build/web/dist /app/web/dist

RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 18084
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '18084') + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/index.js"]
