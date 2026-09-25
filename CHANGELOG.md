# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-09-24

First release as **realtydev/omada-mcp**: 78 tools, published to `ghcr.io/realtydev/omada-mcp`.

### Added

- Static route CRUD (`createRoute`, `updateRoute`, `deleteRoute`) and port forwarding CRUD (`createPortForward`, `updatePortForward`, `deletePortForward`) through the internal web UI API. (@JimmyMultani)
- SSID writes (`updateSsid`, `setSsidEnable`) and `updateFirewallAcl`. (@JimmyMultani)
- IDS/IPS: `getIpsSetting`, `setIpsSetting`. (@JimmyMultani)
- `updateWanPortSetting`, `listAlerts`, `getApRadios`, `setApRadio` (dry run and read-back verification), `getClientHistory`, `setLogNotifications`. (@JimmyMultani)
- `getServerInfo` reports the running version, git commit, and build time. (@JimmyMultani)
- Module and key-prefix filters for `listEvents`. (@JimmyMultani)
- Fusion gateway web-session auth via `OMADA_AUTH_MODE=web`. (@bullitt186)
- `getGatewayWanStatus`: live per-port WAN status.
- DHCP DNS servers (`dhcpns`, `priDns`, `sndDns`), gateway override, and typed custom options on `createLanNetwork` / `updateLanNetwork`.
- Opt-in WAN failover guard (`yarn wan-guard`) for Omada Link Backup false-online failures. See [docs/wan-guard.md](docs/wan-guard.md).
- Release workflow, Dependabot, contributing guide, security policy, and issue templates.

### Fixed

- The server no longer writes a dotenv banner to stdout, which corrupted the MCP stdio transport.
- `setGatewayWanConnect` now calls the `internet-state` endpoint; the old path did not exist.
- Wrong endpoint paths for `getFirmwareDetails`, `listEvents`, `listLogs`. (@JimmyMultani)
- Wrong HTTP verbs for `updateLanNetwork`, `deleteLanNetwork`, `updateFirewallSetting`. (@JimmyMultani)
- `getPortForwardingStatus` UPnP casing and `getSwitchNetworks` pagination. (@JimmyMultani)
- Internal API errors now include the HTTP status, endpoint, and controller error code. (@JimmyMultani)
- `startCableTest` is now marked destructive.

### Changed

- Write tools reject unrecognized fields instead of silently dropping them. (@JimmyMultani)
- Package renamed to `@realtydev/omada-mcp`; the MCP server identifies as `omada-mcp`.
- Container image moved to `ghcr.io/realtydev/omada-mcp`, runs as the non-root `node` user, and reports its git commit.
- Tooling moved from npm to Yarn 4 (Corepack) with Node 24 pinned in `.nvmrc`. (@JimmyMultani)

## [0.5.5] and earlier

Released as [MiguelTVMS/tplink-omada-mcp](https://github.com/MiguelTVMS/tplink-omada-mcp).

[Unreleased]: https://github.com/realtydev/omada-mcp/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/realtydev/omada-mcp/releases/tag/v0.6.0
