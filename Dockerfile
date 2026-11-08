FROM node:24-bookworm-slim AS dashboard
WORKDIR /source
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/package.json
RUN pnpm install --frozen-lockfile
COPY dashboard dashboard
RUN pnpm build

FROM golang:1.27-bookworm AS api
WORKDIR /source
COPY go.mod ./
COPY api api
COPY repository repository
COPY cmd/observatory-api cmd/observatory-api
RUN CGO_ENABLED=0 go build -trimpath -o /out/observatory-api ./cmd/observatory-api

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/package.json
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dashboard /source/dashboard/build ./dashboard/build
COPY --from=api /out/observatory-api ./bin/observatory-api
COPY analysis ./analysis
COPY scripts/production-env.mjs ./scripts/production-env.mjs
ENV PYTHONDONTWRITEBYTECODE=1
USER node
# The API retains its loopback-only listener. Private Linux host-network operation
# is supported; public routing/authentication are deliberately a later release.
ENTRYPOINT ["node", "scripts/production-env.mjs", "start"]
CMD ["-addr", "127.0.0.1:8085", "-history", "/data/history", "-dashboard", "dashboard/build"]
