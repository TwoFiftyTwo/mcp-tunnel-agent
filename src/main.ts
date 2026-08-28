import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { Buffer } from "node:buffer";
import { dirname } from "node:path";
import WebSocket, { type RawData } from "ws";

// ---------------------------------------------------------------------------
// WIRE PROTOCOL — DELIBERATE DUPLICATE of the protocol block in
// services/mcp-tunnel-gateway/src/main.ts. The two services build as
// self-contained Docker contexts (COPY src/ only, same rule as the egress
// proxy's address-guard), so the constants, header allowlists, frame shapes,
// and close codes here exist on BOTH sides. Change one, change both — a
// one-sided edit does not error, it silently breaks every tunnel.
// ---------------------------------------------------------------------------
// See the matching notes in services/mcp-tunnel-gateway/src/protocol.ts.
// REQUESTS are fully buffered on both sides and sized against the gateway's
// 512 MiB task; RESPONSES are streamed chunk-by-chunk, so their ceiling only
// guards against a runaway local server and stays generous for real tool
// results. Both sides must agree, or a payload accepted here is rejected
// mid-tunnel instead of locally with a clear error.
const MAX_HTTP_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES = 6 * 1024 * 1024;
const RESPONSE_CHUNK_BYTES = 256 * 1024;
const MAX_CONCURRENT_REQUESTS = 8;
const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_MAX_MS = 30_000;
const CONTROL_REQUEST_TIMEOUT_MS = 15_000;
// Under the gateway's 75s per-request deadline: the local failure must reach
// the gateway as an error frame before the gateway gives up on its own.
const LOCAL_REQUEST_TIMEOUT_MS = 70_000;
// A session that survives this long counts as healthy: reconnect backoff
// resets. Anything shorter keeps the current backoff so a fast crash/close
// loop cannot hammer the gateway at 1s forever.
const HEALTHY_SESSION_MS = 60_000;
const TUNNEL_PROTOCOL = "twofiftytwo-mcp-tunnel.v1";
/** Reported to the gateway on connect and surfaced in the Data Sources UI. */
const AGENT_VERSION = "1.3.1";
/**
 * Gateway close codes the agent treats specially. (4003 = token expired is
 * deliberately NOT special-cased: the ordinary reconnect path fetches a fresh
 * token anyway, which is exactly the right response.)
 */
const CLOSE_SUPERSEDED = 4001;
const CLOSE_SUPERSEDE_FLOOD = 4009;
const CLOSE_CAPACITY = 4013;

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
]);
const RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "content-type",
  "mcp-session-id",
  "retry-after",
]);
const FORBIDDEN_LOCAL_AUTH_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "transfer-encoding",
]);

interface AgentState {
  version: 1;
  serverId: string;
  agentSecret: string;
  tokenEndpoint: string;
  gatewayUrl: string;
}

interface TokenResponse {
  accessToken: string;
  expiresIn: number;
  gatewayUrl: string;
}

interface TunnelHttpRequestMessage {
  type: "http_request";
  id: string;
  method: "GET" | "POST" | "DELETE";
  headers: Record<string, string>;
  bodyBase64: string;
}

// Outbound frame shapes — the gateway's parseAgentResponseMessage validates
// these at runtime and kills the connection with 1007 on any mismatch, so a
// drift here compiles green on both sides and fails only on the wire. The
// `satisfies` checks at the emit sites are the compile-time half of that
// contract.
interface TunnelHttpResponseStartMessage {
  type: "http_response_start";
  id: string;
  status: number;
  headers: Record<string, string>;
}

interface TunnelHttpResponseChunkMessage {
  type: "http_response_chunk";
  id: string;
  bodyBase64: string;
}

interface TunnelHttpResponseEndMessage {
  type: "http_response_end";
  id: string;
}

interface TunnelHttpResponseErrorMessage {
  type: "http_response_error";
  id: string;
}

/**
 * Discriminate an inbound frame by its `type` field; null for anything that
 * is not a JSON object with a string type. Keeps the message handler a flat
 * switch instead of hand-rolled guard chains.
 */
function frameType(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const t = (value as { type?: unknown }).type;
  return typeof t === "string" ? t : null;
}

interface LocalAuth {
  type: "none" | "bearer" | "header";
  headerName?: string;
  secret?: string;
}

// ENV CONTRACT — the variable names below are spelled out verbatim in the
// README's docker-run example AND in the Data Sources setup wizard
// (frontend/src/components/data-sources/mcp/CustomMcpServersPage.tsx,
// buildTunnelDockerCommand). Renaming or adding a required variable here
// without updating both breaks the customer's copy-paste onboarding path.
const IS_WINDOWS = Deno.build.os === "windows";
const stateFile = Deno.env.get("MCP_TUNNEL_STATE_FILE")?.trim() ||
  defaultStateFile();
const localMcpUrl = parseLocalMcpUrl(requiredEnv("MCP_LOCAL_URL"));
const localAuth = loadLocalAuth();
const proxyUrl = Deno.env.get("MCP_TUNNEL_HTTPS_PROXY")?.trim() ||
  Deno.env.get("HTTPS_PROXY")?.trim() || null;
const controlHttpClient = createControlHttpClient(proxyUrl);
const localHttpClient = createLocalHttpClient(localMcpUrl);
const shutdown = new AbortController();

// Graceful-shutdown signals. SIGBREAK is Windows-only and would throw on
// Linux; SIGHUP is what a closing console window sends on Windows and is
// harmless elsewhere. On Windows the runtime installs a console control
// handler, NOT a Service Control Handler — so `sc stop` on a raw service
// delivers nothing. The supported service wrapper (WinSW, see windows/) sends
// Ctrl+C on stop, which arrives here as SIGINT.
const shutdownSignals: Deno.Signal[] = IS_WINDOWS
  ? ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]
  : ["SIGINT", "SIGTERM", "SIGHUP"];
for (const signal of shutdownSignals) {
  Deno.addSignalListener(signal, () => shutdown.abort());
}

/**
 * Where the enrolled credential lives when MCP_TUNNEL_STATE_FILE is unset.
 * The Docker image sets it explicitly (/data/state.json); elsewhere on Unix
 * the historical CWD-relative path is kept and gets mode 0600.
 *
 * On Windows there is deliberately NO default. The agent cannot express
 * owner-only permissions there (chmod maps to the read-only attribute), so
 * any path it picked on its own — %ProgramData% included, whose inherited
 * ACL grants every local user read — would leave the credential world-
 * readable. The supported install path is windows/install.ps1, which sets
 * MCP_TUNNEL_STATE_FILE explicitly AND ACLs the directory before the agent
 * ever writes to it. Refusing to start is the fail-fast alternative to a
 * silently insecure default.
 */
function defaultStateFile(): string {
  if (!IS_WINDOWS) return "./mcp-tunnel-state.json";
  throw new Error(
    "MCP_TUNNEL_STATE_FILE is required on Windows. Install with windows\\install.ps1, which sets it to an access-controlled directory — do not point it at a folder other local users can read.",
  );
}

/**
 * The client that dials the customer's LOCAL MCP endpoint. Deno's fetch —
 * including a custom client with no proxy configured — honors HTTP_PROXY /
 * HTTPS_PROXY, and machine-wide proxy variables are normal on managed
 * Windows hosts. Left alone, a private http://localhost MCP endpoint would be
 * dialled through the corporate proxy. The MCP endpoint is local by
 * definition, so it is excluded from proxying here, before the client that
 * reaches it is created; the control-plane and tunnel clients keep their own
 * explicit proxy handling.
 */
function createLocalHttpClient(target: URL): Deno.HttpClient {
  const host = target.hostname;
  const existing = Deno.env.get("NO_PROXY")?.trim();
  const already = (existing ?? "").split(",").map((h) =>
    h.trim().toLowerCase()
  );
  if (!already.includes(host.toLowerCase())) {
    Deno.env.set("NO_PROXY", existing ? `${existing},${host}` : host);
  }
  return Deno.createHttpClient({});
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseLocalMcpUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP_LOCAL_URL must use http or https");
  }
  if (url.username || url.password) {
    throw new Error(
      "MCP_LOCAL_URL must not contain credentials; use local auth variables",
    );
  }
  if (url.hash) throw new Error("MCP_LOCAL_URL must not contain a fragment");
  return url;
}

function loadLocalAuth(): LocalAuth {
  const type =
    (Deno.env.get("MCP_LOCAL_AUTH_TYPE")?.trim() || "none") as LocalAuth[
      "type"
    ];
  if (type === "none") return { type };
  if (type === "bearer") {
    return { type, secret: requiredEnv("MCP_LOCAL_AUTH_TOKEN") };
  }
  if (type === "header") {
    const headerName = requiredEnv("MCP_LOCAL_AUTH_HEADER_NAME").toLowerCase();
    // Reject a malformed name HERE, at startup, rather than letting
    // Headers.set() throw on every tunneled request: that throw is caught by
    // the request handler and reported as a generic upstream failure, so the
    // tunnel would sit "connected" while every tool call failed with nothing
    // pointing at the header name. RFC 9110 token charset.
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(headerName)) {
      throw new Error(
        `MCP_LOCAL_AUTH_HEADER_NAME must be a valid HTTP header name, got "${headerName}"`,
      );
    }
    if (FORBIDDEN_LOCAL_AUTH_HEADERS.has(headerName)) {
      throw new Error(`MCP_LOCAL_AUTH_HEADER_NAME cannot be ${headerName}`);
    }
    return {
      type,
      headerName,
      secret: requiredEnv("MCP_LOCAL_AUTH_TOKEN"),
    };
  }
  throw new Error("MCP_LOCAL_AUTH_TYPE must be none, bearer, or header");
}

function createControlHttpClient(
  rawProxyUrl: string | null,
): Deno.HttpClient | null {
  if (!rawProxyUrl) return null;
  const url = new URL(rawProxyUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP_TUNNEL_HTTPS_PROXY must use http or https");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      "MCP_TUNNEL_HTTPS_PROXY must not contain a path, query, or fragment",
    );
  }
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if ((username && !password) || (!username && password)) {
    throw new Error(
      "MCP_TUNNEL_HTTPS_PROXY credentials require both username and password",
    );
  }
  url.username = "";
  url.password = "";
  return Deno.createHttpClient({
    proxy: {
      url: url.toString(),
      ...(username ? { basicAuth: { username, password } } : {}),
    },
  });
}

/**
 * Proxied WebSocket path. The `ws` client cannot ride an outbound proxy under
 * this runtime: node-compat cannot hand a pre-established socket to node:http
 * for the upgrade — https-proxy-agent times out the opening handshake, and a
 * manual `createConnection` dies with "Bad resource ID" (verified against a
 * known-good CONNECT proxy that carries the identical ws version fine under
 * Node). So the proxy leg is built from the Deno-native primitives the
 * control plane already trusts: dial the proxy, speak CONNECT, Deno.startTls
 * to the gateway — then let `ws` dial a one-shot loopback listener bridged
 * onto that TLS stream. `ws` keeps owning every protocol concern (framing,
 * masking, ping/pong, close); the bridge only moves bytes.
 *
 * The credential-bearing proxy URL is never logged and never handed to a
 * dependency: userinfo is stripped and sent as an explicit Proxy-Authorization
 * header on the CONNECT — mirroring createControlHttpClient.
 */
interface ProxyBridge {
  /** ws:// URL on 127.0.0.1 for the `ws` client to dial. */
  url: string;
  /** Host header carrying the real gateway authority. */
  hostHeader: string;
  /** Idempotent; closes the listener and both legs of the bridge. */
  cleanup(): void;
}

const PROXY_TUNNEL_TIMEOUT_MS = 15_000;
const PROXY_CONNECT_HEADER_MAX_BYTES = 16 * 1024;

function startProxyBridge(
  rawProxyUrl: string,
  gatewayUrl: string,
): ProxyBridge {
  const gateway = new URL(gatewayUrl);
  const secure = gateway.protocol === "wss:";
  const gatewayPort = Number(gateway.port) || (secure ? 443 : 80);
  const defaultPort = secure ? 443 : 80;
  const hostHeader = gatewayPort === defaultPort
    ? gateway.hostname
    : `${gateway.hostname}:${gatewayPort}`;

  const proxy = new URL(rawProxyUrl);
  const proxyPort = Number(proxy.port) ||
    (proxy.protocol === "https:" ? 443 : 80);
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);

  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const bridgePort = (listener.addr as Deno.NetAddr).port;

  let closed = false;
  const conns: Deno.Conn[] = [];
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try {
      listener.close();
    } catch {
      // Already closed after the one-shot accept.
    }
    for (const conn of conns) {
      try {
        conn.close();
      } catch {
        // Already closed by the peer or the pump.
      }
    }
  };

  (async () => {
    // One-shot: the first (in-process) dial wins and the listener closes, so
    // nothing else on the host can reach the bridge afterwards.
    const local = await listener.accept();
    listener.close();
    conns.push(local);

    // The whole tunnel establishment races one deadline, matching the ws
    // handshakeTimeout so a dead proxy fails the attempt instead of wedging it.
    const deadline = setTimeout(cleanup, PROXY_TUNNEL_TIMEOUT_MS);
    try {
      let upstream: Deno.Conn = await Deno.connect({
        hostname: proxy.hostname,
        port: proxyPort,
      });
      conns.push(upstream);
      if (proxy.protocol === "https:") {
        // TLS to the proxy itself, then (below) TLS-in-TLS to the gateway.
        upstream = await Deno.startTls(upstream as Deno.TcpConn, {
          hostname: proxy.hostname,
        });
        conns.push(upstream);
      }

      const authHeader = username || password
        ? `Proxy-Authorization: Basic ${
          Buffer.from(`${username}:${password}`).toString("base64")
        }\r\n`
        : "";
      const connectTarget = `${gateway.hostname}:${gatewayPort}`;
      await writeAll(
        upstream,
        new TextEncoder().encode(
          `CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n${authHeader}\r\n`,
        ),
      );

      let head = new Uint8Array(0);
      const chunk = new Uint8Array(4096);
      let leftover = new Uint8Array(0);
      while (true) {
        const n = await upstream.read(chunk);
        if (n === null) throw new Error("proxy closed during CONNECT");
        const merged = new Uint8Array(head.length + n);
        merged.set(head);
        merged.set(chunk.subarray(0, n), head.length);
        head = merged;
        if (head.length > PROXY_CONNECT_HEADER_MAX_BYTES) {
          throw new Error("proxy CONNECT response header too large");
        }
        const text = new TextDecoder("latin1").decode(head);
        const end = text.indexOf("\r\n\r\n");
        if (end === -1) continue;
        const statusLine = text.slice(0, text.indexOf("\r\n"));
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          throw new Error(`proxy refused CONNECT: ${statusLine}`);
        }
        leftover = head.subarray(end + 4);
        break;
      }

      let stream: Deno.Conn = upstream;
      if (secure) {
        // For an https proxy this is TLS-in-TLS; Deno types startTls for
        // TcpConn only, and the runtime may refuse — in which case the error
        // lands in the log below rather than a silent retry loop. Plain http
        // CONNECT proxies (the standard corporate shape) take this path over
        // a TcpConn and are fully supported.
        stream = await Deno.startTls(upstream as Deno.TcpConn, {
          hostname: gateway.hostname,
        });
        conns.push(stream);
      }
      clearTimeout(deadline);

      const pumpUp = local.readable.pipeTo(stream.writable).catch(() => {});
      const pumpDown = (async () => {
        // CONNECT responses cannot carry tunneled bytes before we speak TLS,
        // but a pipelining proxy is cheap to honor.
        if (leftover.length > 0 && !secure) await writeAll(local, leftover);
        await stream.readable.pipeTo(local.writable).catch(() => {});
      })();
      await Promise.all([pumpUp, pumpDown]);
    } catch (error) {
      console.error("[TunnelAgent] proxy tunnel failed", error);
    } finally {
      clearTimeout(deadline);
      cleanup();
    }
  })().catch((error) => {
    // accept() rejecting means cleanup() closed the listener first — routine
    // teardown, not a failure worth logging.
    if (!closed) console.error("[TunnelAgent] proxy bridge failed", error);
  });

  return {
    url: `ws://127.0.0.1:${bridgePort}${gateway.pathname}${gateway.search}`,
    hostHeader,
    cleanup,
  };
}

async function writeAll(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    written += await conn.write(bytes.subarray(written));
  }
}

function controlFetch(input: URL, init: RequestInit): Promise<Response> {
  if (!controlHttpClient) return fetch(input, init);
  return fetch(input, { ...init, client: controlHttpClient } as RequestInit);
}

function validateControlUrl(
  raw: string,
  expectedProtocol: "http" | "ws",
): string {
  const url = new URL(raw);
  const secureProtocol = expectedProtocol === "http" ? "https:" : "wss:";
  const localProtocol = expectedProtocol === "http" ? "http:" : "ws:";
  const loopbackHostnames = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const isSecure = url.protocol === secureProtocol;
  const isLocalDevelopment = url.protocol === localProtocol &&
    loopbackHostnames.has(url.hostname.toLowerCase());
  if (!isSecure && !isLocalDevelopment) {
    throw new Error(`Invalid ${expectedProtocol} tunnel URL`);
  }
  if (url.username || url.password) {
    throw new Error("Tunnel URLs must not contain credentials");
  }
  return url.toString();
}

function isAgentState(value: unknown): value is AgentState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && typeof state.serverId === "string" &&
    typeof state.agentSecret === "string" &&
    typeof state.tokenEndpoint === "string" &&
    typeof state.gatewayUrl === "string";
}

async function readState(): Promise<AgentState | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(stateFile));
    if (!isAgentState(parsed)) {
      throw new Error("state file has an invalid shape");
    }
    return {
      ...parsed,
      tokenEndpoint: validateControlUrl(parsed.tokenEndpoint, "http"),
      gatewayUrl: validateControlUrl(parsed.gatewayUrl, "ws"),
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw new Error(
      `Could not read tunnel state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function writeState(state: AgentState): Promise<void> {
  const directory = dirname(stateFile);
  await Deno.mkdir(directory, { recursive: true });
  const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      createNew: true,
      mode: 0o600,
    });
    await renameWithRetry(temporary, stateFile);
    // On Windows chmod only toggles the read-only attribute — the credential
    // is protected by the directory ACL install.ps1 sets, not by this call.
    if (!IS_WINDOWS) await Deno.chmod(stateFile, 0o600);
  } catch (error) {
    await Deno.remove(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Rename with a short bounded retry. On Windows, antivirus, backup agents and
 * the search indexer routinely hold a just-written file open for a moment,
 * and rename fails with a sharing violation. By the time writeState runs the
 * one-time enrollment token is already spent and the response held the only
 * plaintext copy of the credential — a transient failure here must not throw
 * it away. Five attempts over ~1.5s covers the observed scanner windows;
 * anything longer is a real problem and surfaces as the original error.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  const delaysMs = [100, 200, 300, 400, 500];
  for (let attempt = 0;; attempt++) {
    try {
      await Deno.rename(from, to);
      return;
    } catch (error) {
      if (attempt >= delaysMs.length) throw error;
      await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    }
  }
}

async function enroll(
  enrollmentToken: string,
  /**
   * When re-enrolling after a credential rejection, the agent already HAS an
   * identity. A valid token for a DIFFERENT server (the operator pasted the
   * wrong one on a host running several agents) must not be adopted: the
   * agent would silently switch identity and serve its MCP_LOCAL_URL under
   * another server's name. Checked before writeState so the wrong identity
   * is never persisted either.
   */
  expectedServerId?: string,
): Promise<AgentState> {
  const controlUrl = new URL(
    validateControlUrl(requiredEnv("MCP_TUNNEL_CONTROL_URL"), "http"),
  );
  const endpoint = new URL("/mcp-tunnel/enroll", controlUrl);
  const response = await controlFetch(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enrollmentToken }),
  });
  if (!response.ok) {
    throw new Error(`Tunnel enrollment failed with HTTP ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  if (
    typeof body.serverId !== "string" || typeof body.agentSecret !== "string" ||
    typeof body.tokenEndpoint !== "string" ||
    typeof body.gatewayUrl !== "string"
  ) {
    throw new Error("Tunnel enrollment returned an invalid response");
  }
  if (expectedServerId && body.serverId !== expectedServerId) {
    throw new Error(
      `Enrollment token belongs to a different MCP server (${body.serverId}) — this agent serves ${expectedServerId}. Refusing to switch identity; check MCP_TUNNEL_ENROLLMENT_TOKEN.`,
    );
  }
  const state: AgentState = {
    version: 1,
    serverId: body.serverId,
    agentSecret: body.agentSecret,
    tokenEndpoint: validateControlUrl(body.tokenEndpoint, "http"),
    gatewayUrl: validateControlUrl(body.gatewayUrl, "ws"),
  };
  await writeState(state);
  console.log(`[TunnelAgent] enrollment complete server=${state.serverId}`);
  return state;
}

/**
 * Prove the state file is writable BEFORE redeeming an enrollment token.
 * Enrollment is one-time and the plaintext agent secret exists only in that
 * one response, so a write failure afterwards (read-only mount, wrong owner,
 * full disk) strands the tunnel: the token is spent and the credential is
 * gone. Failing here instead costs nothing — the token is still unused.
 */
async function assertStateWritable(): Promise<void> {
  const probe = `${stateFile}.probe`;
  try {
    await Deno.mkdir(dirname(stateFile), { recursive: true });
    await Deno.writeTextFile(probe, "", { mode: 0o600 });
  } catch (error) {
    throw new Error(
      `Tunnel state directory is not writable (${dirname(stateFile)}): ${
        error instanceof Error ? error.message : String(error)
      }. Fix the volume before enrolling — the enrollment token is one-time.`,
    );
  } finally {
    await Deno.remove(probe).catch(() => {});
  }
}

async function loadOrEnroll(): Promise<AgentState> {
  const state = await readState();
  const enrollmentToken = Deno.env.get("MCP_TUNNEL_ENROLLMENT_TOKEN")?.trim();
  if (state) {
    if (enrollmentToken) {
      console.warn(
        "[TunnelAgent] existing state found; the enrollment token is kept as a fallback and used automatically if the stored credential is rejected",
      );
    }
    return state;
  }
  if (enrollmentToken) {
    await assertStateWritable();
    return await enroll(enrollmentToken);
  }
  throw new Error(
    "No tunnel state exists. Set MCP_TUNNEL_ENROLLMENT_TOKEN and MCP_TUNNEL_CONTROL_URL for first-time enrollment.",
  );
}

/** The control plane rejected our stored credentials — retrying cannot help. */
class AgentCredentialsRejectedError extends Error {
  constructor(status: number) {
    super(`Tunnel token request was rejected with HTTP ${status}`);
    this.name = "AgentCredentialsRejectedError";
  }
}

async function fetchConnectionToken(state: AgentState): Promise<TokenResponse> {
  const response = await controlFetch(new URL(state.tokenEndpoint), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      serverId: state.serverId,
      agentSecret: state.agentSecret,
    }),
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw new AgentCredentialsRejectedError(response.status);
  }
  if (!response.ok) {
    throw new Error(`Tunnel token request failed with HTTP ${response.status}`);
  }
  const body = await response.json() as Record<string, unknown>;
  if (
    typeof body.accessToken !== "string" ||
    typeof body.expiresIn !== "number" ||
    !Number.isFinite(body.expiresIn) || body.expiresIn < 30 ||
    typeof body.gatewayUrl !== "string"
  ) {
    throw new Error("Tunnel token endpoint returned an invalid response");
  }
  return {
    accessToken: body.accessToken,
    expiresIn: body.expiresIn,
    gatewayUrl: validateControlUrl(body.gatewayUrl, "ws"),
  };
}

function filteredHeaderRecord(
  headers: Record<string, string>,
  allowlist: Set<string>,
): Headers {
  const output = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized) && typeof value === "string") {
      output.set(normalized, value);
    }
  }
  return output;
}

function filteredHeaders(
  headers: Headers,
  allowlist: Set<string>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized)) output[normalized] = value;
  }
  return output;
}

function applyLocalAuth(headers: Headers): void {
  if (localAuth.type === "bearer") {
    headers.set("authorization", `Bearer ${localAuth.secret}`);
  } else if (localAuth.type === "header") {
    headers.set(localAuth.headerName!, localAuth.secret!);
  }
}

function parseTunnelRequest(value: unknown): TunnelHttpRequestMessage | null {
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (
    message.type !== "http_request" || typeof message.id !== "string" ||
    !["GET", "POST", "DELETE"].includes(String(message.method)) ||
    typeof message.bodyBase64 !== "string" || !message.headers ||
    typeof message.headers !== "object"
  ) return null;
  return message as unknown as TunnelHttpRequestMessage;
}

function socketSend(socket: WebSocket, message: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Tunnel socket is closed");
  }
  const serialized = JSON.stringify(message);
  if (Buffer.byteLength(serialized, "utf8") > MAX_WS_MESSAGE_BYTES) {
    throw new Error("Tunnel message exceeds the maximum frame size");
  }
  socket.send(serialized);
}

async function handleLocalRequest(
  socket: WebSocket,
  message: TunnelHttpRequestMessage,
  controller: AbortController,
): Promise<void> {
  try {
    const requestBody = decodeBase64(message.bodyBase64);
    if (requestBody.byteLength > MAX_HTTP_BODY_BYTES) {
      throw new Error("request body too large");
    }
    const headers = filteredHeaderRecord(
      message.headers,
      REQUEST_HEADER_ALLOWLIST,
    );
    applyLocalAuth(headers);
    // The deadline is the agent's own: without it, a hung local MCP server
    // leaves this fetch pending forever, cleaned up only if the gateway's
    // cancel frame arrives over a socket that may itself be dead by then.
    const response = await fetch(localMcpUrl, {
      method: message.method,
      headers,
      body: message.method === "POST" ? requestBody : undefined,
      redirect: "error",
      signal: AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(LOCAL_REQUEST_TIMEOUT_MS),
      ]),
      client: localHttpClient,
    } as RequestInit);
    socketSend(
      socket,
      {
        type: "http_response_start",
        id: message.id,
        status: response.status,
        headers: filteredHeaders(response.headers, RESPONSE_HEADER_ALLOWLIST),
      } satisfies TunnelHttpResponseStartMessage,
    );

    if (response.body) {
      const reader = response.body.getReader();
      let total = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel("response body too large");
            throw new Error("response body too large");
          }
          for (
            let offset = 0;
            offset < value.byteLength;
            offset += RESPONSE_CHUNK_BYTES
          ) {
            const chunk = value.subarray(
              offset,
              Math.min(value.byteLength, offset + RESPONSE_CHUNK_BYTES),
            );
            socketSend(
              socket,
              {
                type: "http_response_chunk",
                id: message.id,
                bodyBase64: encodeBase64(chunk),
              } satisfies TunnelHttpResponseChunkMessage,
            );
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    socketSend(
      socket,
      {
        type: "http_response_end",
        id: message.id,
      } satisfies TunnelHttpResponseEndMessage,
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    console.error(
      `[TunnelAgent] local MCP request failed id=${message.id}`,
      error,
    );
    try {
      socketSend(
        socket,
        {
          type: "http_response_error",
          id: message.id,
        } satisfies TunnelHttpResponseErrorMessage,
      );
    } catch {
      // The tunnel closed while reporting the local failure; reconnect loop owns recovery.
    }
  }
}

function eventDataToText(data: RawData, isBinary: boolean): string | null {
  if (isBinary) return null;
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

interface SessionEnd {
  code: number | null;
  openedAtMs: number | null;
}

interface SessionHandle {
  /** Resolves true once the socket opens, false if it never does. */
  opened: Promise<boolean>;
  /** Resolves when the socket closes (whatever the reason). */
  ended: Promise<SessionEnd>;
  /**
   * Resolves shortly before the connection token expires. The main loop
   * responds by opening a REPLACEMENT session with a fresh token; the gateway
   * then drains this one — in-flight requests finish, nothing is dropped.
   * The old refresh design closed the socket outright, killing every
   * in-flight request on a hard 9-minute cadence.
   */
  refreshDue: Promise<void>;
  close(): void;
}

function startSession(state: AgentState, token: TokenResponse): SessionHandle {
  const activeRequests = new Map<string, AbortController>();
  const gatewayUrl = token.gatewayUrl || state.gatewayUrl;
  const bridge = proxyUrl ? startProxyBridge(proxyUrl, gatewayUrl) : null;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token.accessToken}`,
    "x-twofiftytwo-agent-version": AGENT_VERSION,
  };
  // The upgrade travels to the loopback bridge, but the gateway routes on the
  // authority it terminates for — carry it explicitly.
  if (bridge) headers.Host = bridge.hostHeader;
  const socket = new WebSocket(
    bridge ? bridge.url : gatewayUrl,
    TUNNEL_PROTOCOL,
    {
      headers,
      maxPayload: MAX_WS_MESSAGE_BYTES,
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
    },
  );

  let resolveOpened!: (value: boolean) => void;
  const opened = new Promise<boolean>((resolve) => (resolveOpened = resolve));
  let resolveEnded!: (value: SessionEnd) => void;
  const ended = new Promise<SessionEnd>((resolve) => (resolveEnded = resolve));
  let resolveRefreshDue!: () => void;
  const refreshDue = new Promise<void>((
    resolve,
  ) => (resolveRefreshDue = resolve));

  let openedAtMs: number | null = null;
  const heartbeat = setInterval(() => {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socketSend(socket, { type: "ping" });
      }
    } catch {
      // The socket closed between the check and the send; close handling owns recovery.
    }
  }, HEARTBEAT_INTERVAL_MS);
  const refreshTimer = setTimeout(
    resolveRefreshDue,
    Math.max(30_000, token.expiresIn * 1000 - 60_000),
  );
  const abort = () => socket.close(1000, "agent stopping");
  if (shutdown.signal.aborted) {
    // Shutdown arrived while the token fetch was in flight: registering the
    // listener now would never fire. Close immediately instead of serving a
    // full session after we were told to stop.
    abort();
  } else {
    shutdown.signal.addEventListener("abort", abort, { once: true });
  }

  socket.on("open", () => {
    openedAtMs = Date.now();
    resolveOpened(true);
    console.log(`[TunnelAgent] connected server=${state.serverId}`);
  });
  socket.on("message", (data: RawData, isBinary: boolean) => {
    const text = eventDataToText(data, isBinary);
    if (
      text === null || Buffer.byteLength(text, "utf8") > MAX_WS_MESSAGE_BYTES
    ) {
      socket.close(1009, "invalid tunnel message");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      socket.close(1007, "invalid JSON");
      return;
    }
    const kind = frameType(parsed);
    if (kind === "ping") {
      try {
        socketSend(socket, { type: "pong" });
      } catch {
        // A ping racing our own close is routine, not fatal: the socket
        // entered CLOSING between receipt and reply.
      }
      return;
    }
    if (kind === "pong") return;
    if (kind === "cancel") {
      const id = (parsed as { id?: unknown }).id;
      if (typeof id === "string") activeRequests.get(id)?.abort();
      return;
    }
    const request = parseTunnelRequest(parsed);
    if (!request) {
      socket.close(1007, "invalid tunnel request");
      return;
    }
    if (activeRequests.has(request.id)) {
      socket.close(1008, "tunnel protocol violation: duplicate request id");
      return;
    }
    if (activeRequests.size >= MAX_CONCURRENT_REQUESTS) {
      // Not a protocol violation: the gateway frees slots synchronously on
      // cancel while we free ours when the local handler settles, so a brief
      // overshoot is a normal race. Reject just this request; the gateway
      // surfaces it as a 502 and everything in flight lives on.
      try {
        socketSend(
          socket,
          {
            type: "http_response_error",
            id: request.id,
          } satisfies TunnelHttpResponseErrorMessage,
        );
      } catch {
        // Socket is closing; the gateway will fail the request itself.
      }
      return;
    }
    const controller = new AbortController();
    activeRequests.set(request.id, controller);
    handleLocalRequest(socket, request, controller)
      .finally(() => activeRequests.delete(request.id));
  });
  socket.on("error", (error: Error) => {
    if (openedAtMs === null) {
      console.error("[TunnelAgent] connection attempt failed", error);
    }
  });
  socket.on("close", (code: number) => {
    clearInterval(heartbeat);
    clearTimeout(refreshTimer);
    bridge?.cleanup();
    shutdown.signal.removeEventListener("abort", abort);
    for (const controller of activeRequests.values()) controller.abort();
    activeRequests.clear();
    resolveOpened(false);
    console.log(
      `[TunnelAgent] disconnected server=${state.serverId} code=${code}`,
    );
    resolveEnded({ code, openedAtMs });
  });

  return {
    opened,
    ended,
    refreshDue,
    close: () => socket.close(1000, "agent stopping"),
  };
}

function delayAfter(end: SessionEnd, currentDelayMs: number): number {
  // Another agent owns this tunnel: yield rather than fight. The gateway's
  // hold-down rejects flappers with 4009; a superseded incumbent sees 4001.
  if (end.code === CLOSE_SUPERSEDED || end.code === CLOSE_SUPERSEDE_FLOOD) {
    console.warn(
      "[TunnelAgent] another agent connected for this server — backing off. Run exactly one agent per tunnel.",
    );
    return RECONNECT_MAX_MS;
  }
  // The gateway is at capacity (4013). Retrying fast cannot help and only adds
  // to the load that filled it, so wait the full backoff.
  if (end.code === CLOSE_CAPACITY) {
    console.warn(
      "[TunnelAgent] tunnel gateway is at capacity — backing off before retrying.",
    );
    return RECONNECT_MAX_MS;
  }
  // Token expiry (4003) and ordinary drops retry on the backoff schedule; a
  // session that lived long enough resets it, a short-lived one escalates it.
  const lived = end.openedAtMs !== null &&
    Date.now() - end.openedAtMs >= HEALTHY_SESSION_MS;
  return lived ? 1_000 : Math.min(RECONNECT_MAX_MS, currentDelayMs * 2);
}

/** Sleep base + up to 1s of jitter so a fleet never redials in lockstep. */
function sleepWithJitter(baseMs: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 1_000);
  return new Promise((resolve) => setTimeout(resolve, baseMs + jitter));
}

const state = await loadOrEnroll();
let reconnectDelayMs = 1_000;
let current: SessionHandle | null = null;

while (!shutdown.signal.aborted) {
  let token: TokenResponse;
  try {
    token = await fetchConnectionToken(state);
  } catch (error) {
    if (error instanceof AgentCredentialsRejectedError) {
      // Greptile-reported gap: after a credential rotation, the state file
      // holds the revoked secret and a fresh enrollment token in the env was
      // ignored. Self-heal by re-enrolling with it; if that also fails (the
      // token is one-time and may be spent), keep retrying slowly so a
      // restart with a new token — or an admin re-approval — recovers us
      // without manual state-file surgery.
      const enrollmentToken = Deno.env.get("MCP_TUNNEL_ENROLLMENT_TOKEN")
        ?.trim();
      if (enrollmentToken) {
        try {
          const fresh = await enroll(enrollmentToken, state.serverId);
          Object.assign(state, fresh);
          console.log("[TunnelAgent] re-enrolled with the provided token");
          continue;
        } catch (enrollError) {
          console.error("[TunnelAgent] re-enrollment failed", enrollError);
        }
      }
      console.error(
        "[TunnelAgent] stored credentials were rejected — a new enrollment token is required",
      );
      reconnectDelayMs = RECONNECT_MAX_MS;
    } else {
      console.error("[TunnelAgent] token request failed", error);
      reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
    }
    if (shutdown.signal.aborted) break;
    await sleepWithJitter(reconnectDelayMs);
    continue;
  }

  const next = startSession(state, token);
  if (!(await next.opened)) {
    await next.ended;
    // The replacement never opened. If an old session is still serving, keep
    // it and retry the replacement on a timer instead of tearing anything down.
    if (current) {
      const raced = await Promise.race([
        current.ended.then(() => "ended" as const),
        new Promise<"retry">((resolve) =>
          setTimeout(() => resolve("retry"), RECONNECT_MAX_MS)
        ),
      ]);
      if (raced === "ended") current = null;
      continue;
    }
    if (shutdown.signal.aborted) break;
    await sleepWithJitter(reconnectDelayMs);
    reconnectDelayMs = Math.min(RECONNECT_MAX_MS, reconnectDelayMs * 2);
    continue;
  }

  // The replacement is live; the gateway supersedes and drains the old
  // session, closing it once its in-flight requests finish. Nothing to do
  // here but stop tracking it.
  // No backoff reset here: a session only proves health by LIVING (see
  // delayAfter). Resetting on open let an open-then-die loop retry every ~2s
  // forever, defeating the escalation the constant above promises.
  current = next;

  const outcome = await Promise.race([
    current.refreshDue.then(() => "refresh" as const),
    current.ended,
  ]);
  if (outcome === "refresh") continue; // open the replacement; gateway drains this one

  current = null;
  if (shutdown.signal.aborted) break;
  reconnectDelayMs = delayAfter(outcome, reconnectDelayMs);
  await sleepWithJitter(reconnectDelayMs);
}

current?.close();
console.log("[TunnelAgent] stopped");
controlHttpClient?.close();
