FROM node:24-bookworm-slim AS dashboard
WORKDIR /source
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/package.json
COPY vendor vendor
RUN pnpm install --frozen-lockfile
COPY dashboard dashboard
RUN pnpm build

FROM golang:1.27-bookworm AS api
WORKDIR /source
COPY go.mod ./
COPY api api
COPY repository repository
COPY cmd/observatory-api cmd/observatory-api
COPY cmd/observatory-receive cmd/observatory-receive
RUN CGO_ENABLED=0 go build -trimpath -o /out/observatory-api ./cmd/observatory-api \
    && CGO_ENABLED=0 go build -trimpath -o /out/observatory-receive ./cmd/observatory-receive

FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY dashboard/package.json dashboard/package.json
COPY vendor vendor
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./package.json
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dashboard /source/dashboard/build ./dashboard/build
COPY --from=api /out/observatory-api ./bin/observatory-api
COPY --from=api /out/observatory-receive ./bin/observatory-receive
COPY analysis ./analysis
COPY scripts/production-env.mjs ./scripts/production-env.mjs
COPY gateway ./gateway
ENV PYTHONDONTWRITEBYTECODE=1
USER node
# The Go API remains loopback-only; the optional authenticated gateway listens on 8080.
ENTRYPOINT ["node", "scripts/production-env.mjs", "start"]
CMD ["-addr", "127.0.0.1:8085", "-history", "/data/history", "-dashboard", "dashboard/build"]
