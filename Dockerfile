FROM denoland/deno:debian-2.7.8

WORKDIR /app

COPY deno.json deno.lock* ./
COPY src/ ./src/

RUN deno cache --frozen src/main.ts

RUN mkdir -p /data && chown deno:deno /data
USER deno

VOLUME ["/data"]

ENV MCP_TUNNEL_STATE_FILE=/data/state.json

CMD ["run", "--cached-only", "--frozen", "--allow-env", "--allow-net", "--allow-read=/data", "--allow-write=/data", "src/main.ts"]
