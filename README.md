# TwoFiftyTwo MCP tunnel agent

The agent runs inside the institution's network. It connects to a private local
MCP Streamable HTTP endpoint and maintains an outbound-only WSS connection to
TwoFiftyTwo. No inbound firewall rule is required.

Two packagings, same agent:

- **Docker** (Linux / macOS hosts) — build the image from this bundle and run
  it; sections below.
- **Windows service** — a signed native `.exe` installed as a service by
  `install.ps1`; see [Windows](#windows-service) below. No Docker, WSL or
  runtime install needed on the server.

Releases (signed Windows package, Linux/macOS binaries, checksums, this source):
https://github.com/TwoFiftyTwo/mcp-tunnel-agent/releases

## First enrollment (Docker)

Create an **Outbound secure tunnel** connection in TwoFiftyTwo and copy the
one-time enrollment token. Build the versioned agent bundle supplied by
TwoFiftyTwo into your own registry or local Docker daemon:

```bash
docker build -t twofiftytwo-mcp-tunnel-agent:local .
```

Then run (the Data Sources page generates this exact command with the token and
server id pre-filled — you only replace `MCP_LOCAL_URL`). The container name and
state volume carry the server id so one host can run an agent per connected MCP
server without the second colliding with, or adopting the credential of, the
first:

<!-- ENV CONTRACT: the variable names below are duplicated in the agent's
     env-parsing block (src/main.ts) and the Data Sources setup wizard
     (frontend .../CustomMcpServersPage.tsx, buildTunnelDockerCommand).
     Change one, change all three. -->

```bash
docker run -d \
  --restart=unless-stopped \
  -v twofiftytwo-mcp-state-<server-id>:/data \
  -e MCP_TUNNEL_CONTROL_URL=https://api.example.twofiftytwo.ai \
  -e MCP_TUNNEL_ENROLLMENT_TOKEN='the-one-time-token' \
  -e MCP_LOCAL_URL=http://host.docker.internal:8010/mcp \
  --name twofiftytwo-mcp-tunnel-<server-id> \
  twofiftytwo-mcp-tunnel-agent:local
```

The one-time token is exchanged for an agent credential. The credential is
stored in `/data/state.json` (`MCP_TUNNEL_STATE_FILE`) with owner-only POSIX
permissions in the container. (On native Windows a POSIX mode means nothing —
there the directory ACL set by `install.ps1` is the protection; see below.) Once
state exists the agent prefers the stored credential, so a normal restart never
replays a consumed token. A token left in the environment is kept only as a
fallback: if the control plane rejects the stored credential (401/403, e.g.
after an operator replaces the credential), the agent re-enrolls with it
automatically rather than requiring the state file to be deleted by hand.

## Subsequent starts

Reuse the same state volume and omit the enrollment variables:

```bash
docker run --rm \
  -v twofiftytwo-mcp-state-<server-id>:/data \
  -e MCP_LOCAL_URL=http://host.docker.internal:8010/mcp \
  twofiftytwo-mcp-tunnel-agent:local
```

## Local MCP authentication

The local credential remains on the institution's agent and is never sent to
TwoFiftyTwo.

Bearer token:

```text
MCP_LOCAL_AUTH_TYPE=bearer
MCP_LOCAL_AUTH_TOKEN=...
```

Custom header:

```text
MCP_LOCAL_AUTH_TYPE=header
MCP_LOCAL_AUTH_HEADER_NAME=X-Api-Key
MCP_LOCAL_AUTH_TOKEN=...
```

For corporate outbound proxies, set `MCP_TUNNEL_HTTPS_PROXY` (preferred) or
`HTTPS_PROXY`. Proxy credentials may be included in that environment variable;
the agent never logs the proxy URL. Enrollment, token refresh, and the WSS
connection all use the configured proxy.

To replace a revoked agent credential, generate a new enrollment token in
TwoFiftyTwo, then restart the agent with `MCP_TUNNEL_ENROLLMENT_TOKEN` set to
the new token. The stored credential is preferred while it still works, but the
moment the control plane rejects it the agent re-enrolls with the provided token
automatically — no state-file surgery needed. Removing the state file/volume
before restarting also works and forces immediate re-enrollment.

## Windows service

Download `twofiftytwo-mcp-tunnel-windows-x64-v*.zip` from the releases page,
extract it on the server, and from an **elevated** PowerShell in that folder:

```powershell
.\install.ps1 -ControlUrl 'https://<your-twofiftytwo-api-host>' `
  -EnrollmentToken '<one-time token from the Data Sources wizard>' `
  -McpLocalUrl 'http://localhost:8010/mcp'
```

The Data Sources wizard shows this exact command with the token and control URL
already filled in. Optional: `-LocalAuthType bearer|header`, `-LocalAuthToken`,
`-LocalAuthHeaderName`, `-HttpsProxy` (see _Local MCP authentication_).

What `install.ps1` does:

- installs to `C:\Program Files\TwoFiftyTwo\MCP Tunnel\` and registers the
  service `twofiftytwo-mcp-tunnel` (WinSW wrapper, delayed auto-start,
  restart-on-failure) running under its own virtual service account
  `NT SERVICE\twofiftytwo-mcp-tunnel` — no password to store or rotate;
- keeps the credential in
  `C:\ProgramData\TwoFiftyTwo\mcp-tunnel-agent\state.json` and ACLs that
  directory to SYSTEM, Administrators, and the service account only
  (inheritable, so credential rotation keeps the protection);
- sets `DENO_TLS_CA_STORE=system` so the agent trusts the Windows certificate
  store — required behind TLS-inspecting proxies (Zscaler, Netskope, Palo Alto);
- starts the service, waits for enrollment, then **removes the one-time token
  from the service configuration** and restarts, so the only long-lived secret
  on disk is the ACL-protected state file. (Every Windows per-service
  environment mechanism stores values readable by local administrators.)

Both executables and both scripts are Authenticode-signed by TwoFiftyTwo, so
they can be allow-listed by publisher and run under an `AllSigned` execution
policy. Logs: `C:\Program Files\TwoFiftyTwo\MCP Tunnel\logs\`. Status:
`Get-Service twofiftytwo-mcp-tunnel`. Stop/start via the Services console or
`sc.exe` — the wrapper sends the agent a graceful shutdown. Remove with
`uninstall.ps1` (add `-RemoveState` to also delete the credential).

Re-running `install.ps1` with a fresh token re-enrolls an existing install
(after _Replace tunnel credential_ in Data Sources).

### Updates

The tunnel never updates itself — the service account cannot write to its own
install directory, by design. To be told about new versions, **watch the
releases** of https://github.com/TwoFiftyTwo/mcp-tunnel-agent (Watch → Custom →
Releases). To update, download the new package and re-run `install.ps1` with the
same arguments; it stops the service, replaces the binaries, and restarts. The
credential in `ProgramData` is kept, so no new enrollment token is needed.
Docker installs update by rebuilding the image from the new bundle and
recreating the container on the same state volume. Releases stay wire-compatible
with older tunnels; a release note will say so explicitly if one ever is not.

## Network requirements

- outbound TCP 443 to the TwoFiftyTwo API hostname, directly or through the
  configured HTTPS CONNECT proxy;
- access from the agent container/process to the private MCP endpoint. This call
  is made directly — the agent excludes the MCP host from any
  `HTTP_PROXY`/`HTTPS_PROXY` set machine-wide, so a private endpoint is never
  dialled through a corporate proxy;
- no inbound internet access.
