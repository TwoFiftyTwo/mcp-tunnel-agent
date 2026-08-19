# TwoFiftyTwo MCP tunnel agent

A small program you run on a machine inside your network. It connects your
private MCP server to TwoFiftyTwo through an **outbound-only** encrypted
connection, so TwoFiftyTwo's analyst can use your MCP tools without any inbound
firewall rule, VPN, or public endpoint on your side.

Pick your platform and follow the steps. Everything else in this document is
reference material you can come back to.

- [Before you start (all platforms)](#before-you-start-all-platforms)
- [Windows — step by step](#windows--step-by-step)
- [Linux — step by step](#linux--step-by-step)
- [macOS — step by step](#macos--step-by-step)
- [After it is running](#after-it-is-running)
- [How it works](#how-it-works)
- [Configuration reference](#configuration-reference)
- [Windows service details](#windows-service-details)
- [Updates](#updates)
- [Troubleshooting](#troubleshooting)
- [Network requirements](#network-requirements)

Downloads (signed Windows package, Linux/macOS binaries, checksums, source):
https://github.com/TwoFiftyTwo/mcp-tunnel-agent/releases/latest

## Before you start (all platforms)

You need three things:

1. **Your MCP server's URL**, as reachable from the machine that will run the
   tunnel — for example `http://localhost:8010/mcp`. It must speak MCP
   Streamable HTTP. If it needs a token or API key, have that ready too.
2. **A one-time enrollment token** from TwoFiftyTwo. A TwoFiftyTwo administrator
   opens **Data Sources → Custom MCP servers → Add server**, names the server,
   and the setup wizard shows the token together with the exact command for your
   platform. The token can be used once and expires. If it lapses before the
   agent enrolled, the server's setup card offers **Generate enrollment token**;
   once an agent is enrolled, **⋯ → Replace tunnel credential** issues a new one
   instead.
3. **Outbound HTTPS (TCP 443)** from that machine to your TwoFiftyTwo API host,
   directly or through your corporate proxy. Nothing inbound.

The wizard's command already contains your TwoFiftyTwo API URL and token; the
only value you type yourself is your MCP server URL. Commands below use
placeholders in `<angle brackets>`.

## Windows — step by step

Runs as a Windows service. No Docker, WSL, or runtime install needed.

1. Download `twofiftytwo-mcp-tunnel-windows-x64-v<version>.zip` from the
   [releases page](https://github.com/TwoFiftyTwo/mcp-tunnel-agent/releases/latest)
   and extract it anywhere on the server (for example the Desktop).
2. Open **PowerShell as Administrator** and `cd` into the extracted folder.
3. Run the install command from the wizard's **Windows** tab. It looks like:

   ```powershell
   .\install.ps1 -ControlUrl 'https://<your-twofiftytwo-api-host>' -EnrollmentToken '<one-time token>' -McpLocalUrl 'http://localhost:8010/mcp'
   ```

   If your MCP server needs a credential, add
   `-LocalAuthType bearer -LocalAuthToken '<token>'` (or
   `-LocalAuthType header -LocalAuthHeaderName 'X-Api-Key' -LocalAuthToken '<key>'`).
   Behind an outbound proxy, add `-HttpsProxy 'http://proxy.corp:3128'`.
4. Wait for
   `Enrolled. The tunnel is running as service 'twofiftytwo-mcp-tunnel'`. The
   service starts automatically with Windows from now on.
5. Continue with [After it is running](#after-it-is-running).

Check it later with `Get-Service twofiftytwo-mcp-tunnel`. Logs are in
`C:\Program Files\TwoFiftyTwo\MCP Tunnel\logs\`. Remove with `.\uninstall.ps1`
(add `-RemoveState` to also delete the stored credential). Both executables and
both scripts are Authenticode-signed by TwoFiftyTwo Pte. Ltd.

## Linux — step by step

Runs as a single static binary under systemd. (Docker also works — see
[macOS](#macos--step-by-step), the commands are identical on Linux.)

1. Download the binary, verify it against the published checksums, and put it in
   place (pick `x64` or `arm64`):

   ```bash
   cd "$(mktemp -d)"
   base=https://github.com/TwoFiftyTwo/mcp-tunnel-agent/releases/latest/download
   curl -sSLO "$base/mcp-tunnel-agent-linux-x64.tar.gz" -O "$base/SHA256SUMS"
   sha256sum --check --ignore-missing SHA256SUMS &&
     tar -xzf mcp-tunnel-agent-linux-x64.tar.gz &&
     sudo install -m 755 mcp-tunnel-agent-linux-x64 /usr/local/bin/twofiftytwo-mcp-tunnel
   ```

   `sha256sum` must print `mcp-tunnel-agent-linux-x64.tar.gz: OK`; the `&&`
   chain makes sure nothing is extracted or installed if it does not.

2. Create a dedicated user and a root-only settings file:

   ```bash
   sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin tfmcp
   sudo install -d -m 700 -o tfmcp -g tfmcp /var/lib/twofiftytwo-mcp-tunnel
   sudo install -d -m 700 /etc/twofiftytwo-mcp-tunnel
   sudo tee /etc/twofiftytwo-mcp-tunnel/env >/dev/null <<'EOF'
   MCP_TUNNEL_CONTROL_URL=https://<your-twofiftytwo-api-host>
   MCP_TUNNEL_ENROLLMENT_TOKEN=<one-time token>
   MCP_LOCAL_URL=http://localhost:8010/mcp
   MCP_TUNNEL_STATE_FILE=/var/lib/twofiftytwo-mcp-tunnel/state.json
   EOF
   sudo chmod 600 /etc/twofiftytwo-mcp-tunnel/env
   ```

   Add `MCP_LOCAL_AUTH_TYPE=bearer` and `MCP_LOCAL_AUTH_TOKEN=...` if your MCP
   server needs a credential; `MCP_TUNNEL_HTTPS_PROXY=...` behind a proxy. See
   [Configuration reference](#configuration-reference).

3. Create the service and start it:

   ```bash
   sudo tee /etc/systemd/system/twofiftytwo-mcp-tunnel.service >/dev/null <<'EOF'
   [Unit]
   Description=TwoFiftyTwo MCP tunnel agent
   After=network-online.target
   Wants=network-online.target

   [Service]
   User=tfmcp
   Group=tfmcp
   EnvironmentFile=/etc/twofiftytwo-mcp-tunnel/env
   ExecStart=/usr/local/bin/twofiftytwo-mcp-tunnel
   Restart=always
   RestartSec=5
   NoNewPrivileges=true
   ProtectSystem=strict
   ProtectHome=true
   PrivateTmp=true
   ReadWritePaths=/var/lib/twofiftytwo-mcp-tunnel

   [Install]
   WantedBy=multi-user.target
   EOF
   sudo systemctl daemon-reload
   sudo systemctl enable --now twofiftytwo-mcp-tunnel
   ```

4. Confirm it enrolled: `journalctl -u twofiftytwo-mcp-tunnel -n 20` should show
   a successful enrollment and connection. After that you may delete the
   `MCP_TUNNEL_ENROLLMENT_TOKEN=` line from the settings file (optional — a used
   token is never replayed; leaving it only lets the agent re-enroll by itself
   if the credential is ever replaced).
5. Continue with [After it is running](#after-it-is-running).

## macOS — step by step

Runs in Docker Desktop. (The same commands work on any Linux host with Docker,
and a native macOS binary is in the releases if you prefer to run it directly
with the same environment variables as the Linux steps.)

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and
   make sure it is running.
2. Build the image from the source of the latest release:

   ```bash
   git clone --depth 1 https://github.com/TwoFiftyTwo/mcp-tunnel-agent.git
   cd mcp-tunnel-agent
   docker build -t twofiftytwo-mcp-tunnel-agent:local .
   ```

3. Run the command from the wizard's **Docker** tab. It looks like:

   <!-- ENV CONTRACT: the variable names below are duplicated in the agent's
        env-parsing block (src/main.ts) and the Data Sources setup wizard
        (frontend .../TunnelEnrollmentPanel.tsx, buildTunnelDockerCommand).
        Change one, change all three. -->

   ```bash
   docker run -d \
     --restart=unless-stopped \
     -v twofiftytwo-mcp-state-<server-id>:/data \
     -e MCP_TUNNEL_CONTROL_URL=https://<your-twofiftytwo-api-host> \
     -e MCP_TUNNEL_ENROLLMENT_TOKEN='<one-time token>' \
     -e MCP_LOCAL_URL=http://host.docker.internal:8010/mcp \
     --name twofiftytwo-mcp-tunnel-<server-id> \
     twofiftytwo-mcp-tunnel-agent:local
   ```

   `host.docker.internal` is how a container reaches a server running on the Mac
   itself; use the real hostname if your MCP server is elsewhere. (On Linux
   Docker Engine, add `--add-host=host.docker.internal:host-gateway` to the
   command for that name to resolve.) Add
   `-e MCP_LOCAL_AUTH_TYPE=bearer -e MCP_LOCAL_AUTH_TOKEN=...` if it needs a
   credential.
4. Confirm it enrolled: `docker logs twofiftytwo-mcp-tunnel-<server-id>`. The
   container restarts with Docker; the credential lives in the named volume, so
   later restarts need no token.
5. Continue with [After it is running](#after-it-is-running).

## After it is running

1. In TwoFiftyTwo, open **Data Sources → Custom MCP servers**. The server card
   shows the tunnel as connected within a few seconds.
2. Click **⋯ → Refresh tools**. The tunnel asks your MCP server for its tool
   list and shows it on the card.
3. A TwoFiftyTwo administrator reviews the tool list in **Admin → Custom MCP**
   and clicks **Approve**. Only after approval can the analyst use the tools;
   any later change to the tool list puts the server back into review.

That is the whole setup. The rest of this document explains what is going on
underneath and how to change things later.

## How it works

- **One direction, one endpoint.** The agent opens an outbound WebSocket (WSS)
  to TwoFiftyTwo and keeps it open. Requests for your MCP server travel back
  over that connection. The agent forwards them to the single URL you configured
  (`MCP_LOCAL_URL`) and nowhere else — the message format has no field for a
  host or path, and redirects are refused. Nothing on the TwoFiftyTwo side can
  reach any other machine, port, or path through it.
- **Only approved tools are callable.** TwoFiftyTwo registers exactly the tools
  an administrator approved for this server (Admin → Custom MCP). Calls to
  anything else are rejected before they reach the tunnel.
- **Three credentials, each narrower than the last.** The one-time enrollment
  token is exchanged for a long-lived agent credential (stored only on your
  machine, hashed on ours); the agent uses that to fetch short-lived tokens for
  the live connection. Replacing the credential in TwoFiftyTwo (**⋯ → Replace
  tunnel credential**) stops the old agent from getting any new short-lived
  token; a session it already holds ends within 10 minutes.
- **Your MCP credential stays with you.** If your MCP server needs a token or
  API key, the agent presents it locally on each call. It is never sent to
  TwoFiftyTwo.
- **State file.** The agent keeps its credential in one JSON file (Docker: the
  `/data` volume; Windows: `C:\ProgramData\TwoFiftyTwo\mcp-tunnel-agent`; Linux:
  wherever `MCP_TUNNEL_STATE_FILE` points). Once it exists, restarts never
  replay the enrollment token. If TwoFiftyTwo rejects the stored credential (for
  example after **Replace tunnel credential**), the agent re-enrolls
  automatically with whatever `MCP_TUNNEL_ENROLLMENT_TOKEN` is set, so a
  credential replacement is: get a new token, restart the agent with it.

## Configuration reference

All settings are environment variables (Windows: `install.ps1` parameters that
set them for the service).

| Variable                      | Required  | Meaning                                                                                                                                                    |
| ----------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_TUNNEL_CONTROL_URL`      | yes       | Your TwoFiftyTwo API origin, e.g. `https://api.twofiftytwo.ai`. Shown in the wizard. Must be `https`.                                                      |
| `MCP_TUNNEL_ENROLLMENT_TOKEN` | first run | One-time token from the wizard. Ignored once a credential is stored, except to re-enroll after the credential is replaced.                                 |
| `MCP_LOCAL_URL`               | yes       | Your MCP server's Streamable HTTP endpoint as reachable from the agent (`http://` or `https://`). Put credentials in the auth variables, never in the URL. |
| `MCP_TUNNEL_STATE_FILE`       | Windows   | Where the credential is stored. Defaults to `./mcp-tunnel-state.json` on Linux/macOS (`/data/state.json` in Docker); required on Windows.                  |
| `MCP_LOCAL_AUTH_TYPE`         | no        | `none` (default), `bearer`, or `header`.                                                                                                                   |
| `MCP_LOCAL_AUTH_TOKEN`        | if auth   | The bearer token or header value presented to your MCP server.                                                                                             |
| `MCP_LOCAL_AUTH_HEADER_NAME`  | if header | Header name for `MCP_LOCAL_AUTH_TYPE=header`, e.g. `X-Api-Key`.                                                                                            |
| `MCP_TUNNEL_HTTPS_PROXY`      | no        | Outbound proxy for reaching TwoFiftyTwo, e.g. `http://user:pass@proxy.corp:3128`. Falls back to `HTTPS_PROXY`. Never logged.                               |

Local authentication examples:

```text
MCP_LOCAL_AUTH_TYPE=bearer
MCP_LOCAL_AUTH_TOKEN=...
```

```text
MCP_LOCAL_AUTH_TYPE=header
MCP_LOCAL_AUTH_HEADER_NAME=X-Api-Key
MCP_LOCAL_AUTH_TOKEN=...
```

Proxies: enrollment, token refresh, and the WSS connection all go through the
configured proxy. The call to your MCP server does **not** — the agent excludes
that host from any machine-wide `HTTP_PROXY`/`HTTPS_PROXY`, so a private
endpoint is never dialled through a corporate proxy.

Running more than one tunnel on a host: give each its own state file/volume and
container name (the wizard's Docker command already includes the server id in
both), so a second agent never adopts the first one's credential.

## Windows service details

What `install.ps1` does, for the people who need to sign off on it:

- installs to `C:\Program Files\TwoFiftyTwo\MCP Tunnel\` and registers the
  service `twofiftytwo-mcp-tunnel` (WinSW wrapper, delayed auto-start,
  restart-on-failure) under its own virtual service account
  `NT SERVICE\twofiftytwo-mcp-tunnel` — no password to store or rotate;
- keeps the credential in
  `C:\ProgramData\TwoFiftyTwo\mcp-tunnel-agent\state.json` and ACLs that
  directory to SYSTEM, Administrators, and the service account only
  (inheritable, so credential rotation keeps the protection); the install
  directory is locked the same way with the service account read-only;
- sets `DENO_TLS_CA_STORE=system` so the agent trusts the Windows certificate
  store — required behind TLS-inspecting proxies (Zscaler, Netskope, Palo Alto);
- starts the service, waits for enrollment, then **removes the one-time token
  from the service configuration** and restarts, so the only long-lived secret
  on disk is the ACL-protected state file (every Windows per-service environment
  mechanism is readable by local administrators).

Both executables and both scripts are Authenticode-signed by TwoFiftyTwo, so
they can be allow-listed by publisher and run under an `AllSigned` execution
policy. Stop/start via the Services console or `sc.exe` — the wrapper sends the
agent a graceful shutdown. Re-running `install.ps1` with a fresh token
re-enrolls an existing install (after **Replace tunnel credential**).

## Updates

The tunnel never updates itself — on Windows the service account cannot even
write to its own install directory, by design. To be told about new versions,
**watch the releases** of https://github.com/TwoFiftyTwo/mcp-tunnel-agent (Watch
→ Custom → Releases). Then:

- **Windows:** download the new package and re-run `install.ps1` with the same
  arguments; it stops the service, replaces the binaries, and restarts. The
  credential is kept, so no new enrollment token is needed.
- **Linux:** repeat step 1 of the Linux section (download, verify, install),
  then `sudo systemctl restart twofiftytwo-mcp-tunnel`.
- **Docker:** `git pull`, rebuild the image, and recreate the container on the
  same state volume.

Releases stay wire-compatible with older tunnels; a release note will say so
explicitly if one ever is not.

## Troubleshooting

- **The service started but has not enrolled** (Windows) / logs show enrollment
  failing: the token was already used or has expired — get a new one via **⋯ →
  Replace tunnel credential** and re-run the install; or outbound 443 to the
  TwoFiftyTwo API host is blocked; or a TLS-inspecting proxy is in the way
  (Windows trusts the system store; on Linux/Docker set `MCP_TUNNEL_HTTPS_PROXY`
  and make sure the proxy's CA is trusted).
- **Card says connected but "Refresh tools" fails:** the agent cannot reach
  `MCP_LOCAL_URL` from where it runs. In Docker, `localhost` is the container,
  not the host — use `host.docker.internal` (Docker Desktop) or the host's
  address. Check any local credential (`MCP_LOCAL_AUTH_*`).
- **"MCP_TUNNEL_STATE_FILE is required on Windows":** the binary was started by
  hand instead of through `install.ps1`; use the installer, which sets it to an
  access-controlled directory.
- **Approve is greyed out in TwoFiftyTwo:** click **Refresh tools** first — a
  server with no fetched tool list has nothing to approve.

## Network requirements

- outbound TCP 443 to the TwoFiftyTwo API hostname, directly or through the
  configured HTTPS CONNECT proxy;
- access from the agent process/container to the private MCP endpoint;
- no inbound internet access, no VPN, no public endpoint.
