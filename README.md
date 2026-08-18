# TwoFiftyTwo MCP tunnel agent

The customer-run half of the TwoFiftyTwo MCP tunnel: a small agent that runs
inside your network, next to your private MCP server, and holds a single
outbound-only WebSocket connection to TwoFiftyTwo. No inbound ports, no public
endpoint; your MCP URL and its credential never leave your network.

**Downloads** — see [Releases](../../releases). Each release ships:

- `twofiftytwo-mcp-tunnel-windows-x64-v*.zip` — Windows service package
  (agent + service wrapper + `install.ps1`), Authenticode-signed by TwoFiftyTwo
- `mcp-tunnel-agent-linux-{x64,arm64}` and `mcp-tunnel-agent-macos-{arm64,x64}`
- `SHA256SUMS`

**Setup** — start from **Data Sources → Custom MCP Servers → Add server** in
TwoFiftyTwo. The wizard issues a one-time enrollment token and shows the exact
command for your platform, pre-filled with your server's id.

The source in this repository is a snapshot of `services/mcp-tunnel-agent` from
TwoFiftyTwo's internal monorepo, exported on every release, so what runs inside
your network is readable here.
