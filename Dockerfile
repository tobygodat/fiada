# The indexer as a container, for a host that runs long-lived servers with a
# disk (Railway, Fly.io, Render). It clones repositories, parses them with
# tree-sitter (WASM) and serves the graph; the map itself is a static build
# that lives elsewhere (Vercel) and calls this through VITE_API_URL.
#
#   docker build -t fiada-indexer .
#   docker run -p 4178:4178 -e MONGODB_URI=… -e FIADA_ALLOWED_ORIGINS=https://hackgt13.vercel.app fiada-indexer

FROM node:22-bookworm-slim

# git clones the repositories people import.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Only the indexer's dependencies. Every workspace's manifest comes along so
# the lockfile still matches.
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY indexer/package.json indexer/
COPY web/package.json web/
COPY agent/package.json agent/
RUN npm ci --workspace @strata/indexer --omit=dev --no-audit --no-fund

COPY shared shared
COPY indexer indexer

# Clones and (without MONGODB_URI) project files live here. Mount a volume on
# /data to keep clones across deploys; with MONGODB_URI set the project is in
# Atlas anyway and a fresh container re-clones its repositories on start.
RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4178 \
    FIADA_HOME=/data
EXPOSE 4178

CMD ["node", "--import", "tsx", "indexer/src/server.ts"]
