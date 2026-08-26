# Changelog

## 1.3.0

- Published as a multi-arch (amd64 + arm64) container image:
  `ghcr.io/twofiftytwo/mcp-tunnel-agent`, tagged `X.Y.Z` and `X`. Images are
  signed with cosign (keyless) and carry SLSA build provenance — see the README
  for verification commands. Building from source remains supported.

## 1.2.2

- Windows installer rides out the agent's image lock when replacing or removing
  binaries, and an upgrade re-run is recognized as success once the tunnel
  reconnects.

## 1.2.1

- Proxied tunnel WebSocket is carried over a Deno-native loopback bridge, fixing
  WSS through corporate HTTPS proxies.

## 1.2.0

- Windows service install: Authenticode-signed agent and service wrapper with
  `install.ps1` / `uninstall.ps1`.
- First public release on this repository.
