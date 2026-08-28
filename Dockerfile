FROM denoland/deno:debian-2.7.8

# Patch base-OS CVEs at build time (openssl et al.). APT_CACHE_BUST is passed
# by the release workflow (the release tag) so this layer is rebuilt — and
# patches picked up — on every published release rather than served from a
# stale build cache.
ARG APT_CACHE_BUST=1
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY deno.json deno.lock* ./
COPY src/ ./src/

RUN deno cache --frozen src/main.ts

RUN mkdir -p /data && chown deno:deno /data
USER deno

VOLUME ["/data"]

ENV MCP_TUNNEL_STATE_FILE=/data/state.json

CMD ["run", "--cached-only", "--frozen", "--allow-env", "--allow-net", "--allow-read=/data", "--allow-write=/data", "src/main.ts"]
