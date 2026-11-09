# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `OMADA_CA_FILE` trusts a private PEM certificate bundle while retaining certificate and hostname verification.
- `getSiteDashboard` collects bounded Wi-Fi, traffic, retry/drop, switch and PoE summaries, with explicit partial results.
- `locateDevice` blinks a single device; `setSiteLed` explicitly controls LEDs across a site.
- Weekly CI reruns dependency auditing and validation even when the repository has no new commits.

- Focused `omada-runtime` CLI: setup, doctor, status, exact-version updates and rollback for client-managed stdio and persistent local Docker services, including adoption of existing Compose deployments.
- Release runtime archives with executable package bins and an archive/launcher MCP smoke check in CI.

### Fixed

- LAN profile updates use PATCH, and public gateway ACL operations use the documented Open API resources while preserving web API access.
- Authenticated requests no longer follow redirects, and request logging preserves special JSON property names while masking secrets.
- Client writes use setting-specific endpoints, validate all inputs before mutations, preserve unchanged rate-limit/IP settings and support previews. Partial write failures identify completed settings without automatically replaying mutations.
- Device adoption supports device credentials and firmware upgrades use the documented start endpoints.
- The deprecated `setDeviceLed` tool now reports unsupported instead of calling an undocumented endpoint; choose single-device locating or site-wide LED control explicitly.
- Executable shebang for the `omada-mcp` package bin. Managed stdio launches use the selected credential file without working-directory dotenv overrides.

## [0.7.0] - 2026-11-08

### Added

- DHCP reservation list/create/update/delete tools with strict inputs, previews, no-op detection, and bounded read-back verification. Uncertain writes are reconciled without replaying mutations.
- Site topology, VPN connection status, and saved gateway WAN speed-test results.
- Client-path and log diagnostics with explicit query windows, unavailable sections, truncation and topology staleness.
- Optional read-only tool profile and a guarded, repeatable `yarn smoke:readonly` hardware check.

- `listSwitchPorts`: paginated site-wide switch link, traffic, STP, LLDP and PoE telemetry with optional case-insensitive MAC filtering; contributor-tested on ES206GP with Controller 6.2.14.11. (@tkdpython, Paul)
- Read-only AP diagnostics: `getApRfScanResults` (non-deprecated Open API v2), `getApAfcStatus`, and `getApAvailableChannels`. These read existing telemetry without scanning or changing radio settings.

### Fixed

- Malformed, incomplete, repeated and non-advancing paginated responses now fail explicitly; DHCP verification also rejects missing or duplicated MAC evidence.
- Concurrent OAuth renewal and web/internal login races; invalidated authentication results and late failures no longer overwrite newer credentials.
- HTTP/SSE session retention is bounded by configurable idle expiry and capacity. In-flight tool calls survive idle sweeps, and resources are released on close/shutdown.
- SSE double-start failures and SDK session query routing; retry failures retain detailed controller errors.

### Changed

- Refreshed compatible runtime and development dependencies, including MCP SDK 1.32, ngrok 1.7, Biome 2.6 and Vitest 5.1, and updated transitive packages to clear known audit findings.
- Kept Node types on the supported Node 24 line and disabled automatic major Node type upgrades in Dependabot.
- Synchronized Docker authentication and tool documentation, and updated contributor automation guidance to match the current runtime and authentication modes.

## [0.6.1] - 2026-09-24

### Changed

- Upgraded to zod 4, MCP SDK 1.30, dotenv 18, TypeScript 7, vitest 5 and Biome 2.5. Tool schemas no longer use `$ref`, so clients that don't resolve references now see every field.
- Removed the unused `concurrently` dev dependency.

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
- `OMADA_TIMEOUT` now really defaults to 30 s; previously requests never timed out unless it was set.
- Web-session cookies are redacted from debug logs, and concurrent requests share a single web login.

### Changed

- Write tools reject unrecognized fields instead of silently dropping them. (@JimmyMultani) This includes nested `dhcpSettingsVO` on LAN networks, so strip read-only fields from `getLanNetworkList` output before reusing it.
- Package renamed to `@realtydev/omada-mcp`; the MCP server identifies as `omada-mcp`.
- Container image moved to `ghcr.io/realtydev/omada-mcp`, runs as the non-root `node` user, and reports its git commit.
- Tooling moved from npm to Yarn 4 (Corepack) with Node 24 pinned in `.nvmrc`. (@JimmyMultani)

## [0.5.5] and earlier

Released as [MiguelTVMS/tplink-omada-mcp](https://github.com/MiguelTVMS/tplink-omada-mcp).

[Unreleased]: https://github.com/realtydev/omada-mcp/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/realtydev/omada-mcp/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/realtydev/omada-mcp/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/realtydev/omada-mcp/releases/tag/v0.6.0
