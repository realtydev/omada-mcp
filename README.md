<div align="center">

# Omada MCP

**Discover, diagnose, and manage your TP-Link Omada network.** A Model Context Protocol server for Claude, Cursor, and other MCP clients. Search the controller's API, inspect operation schemas, and execute validated requests alongside dedicated tools for network diagnostics and configuration. Manage local stdio and Docker installations with the runtime CLI.

[![CI](https://github.com/realtydev/omada-mcp/actions/workflows/pull-requests.yml/badge.svg)](https://github.com/realtydev/omada-mcp/actions/workflows/pull-requests.yml)
[![Release](https://img.shields.io/github/v/release/realtydev/omada-mcp?sort=semver)](https://github.com/realtydev/omada-mcp/releases)
[![Container](https://img.shields.io/badge/ghcr.io-realtydev%2Fomada--mcp-2496ED?logo=docker&logoColor=white)](https://github.com/realtydev/omada-mcp/pkgs/container/omada-mcp)
[![Node 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](.nvmrc)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

> **Release:** [v0.10.1](https://github.com/realtydev/omada-mcp/releases/tag/v0.10.1) includes 104 tools, automatic API discovery, richer diagnostics and verified profile rollback. Use `getServerInfo` to confirm the running build.

```text
You:    Why is the guest SSID slow on the upstairs AP?
Claude: (getApRadios → listClientsActivity → getSsidDetail)
        The 5 GHz radio on "AP-Upstairs" is on channel 149 at 80 MHz with 23% retries…
You:    Move it to 36 at 40 MHz, dry run first.
Claude: (setApRadio dryRun=true → setApRadio) Done. Read back and verified.
```

## Runtime management

Use the [runtime CLI](docs/runtime.md) for setup, doctor, status, version-pinned updates and rollback of client-managed stdio processes or a persistent local Docker service. It verifies actual running builds with `getServerInfo`, preserves credential files, and can adopt an existing Compose service. Setup can configure Codex, Cursor and Claude Desktop automatically; updates report client reload results and support optional desktop restarts.

Current source adds per-AP SSID override workflows (106 tools; 55 in read-only mode before category filtering). These additions await the next release. See [per-AP overrides](docs/ap-ssid-overrides.md).

## Highlights

- **Automatic API discovery.** `searchApiOperations` → `describeApiOperation` → `executeApiOperation`. Prefer the controller's live specification, with an explicit bundled fallback containing 1,676 indexed operations. Unsupported operations are identified; a catalogue entry does not prove device support. See [API discovery](docs/api-discovery.md).
- **106 tools in the current source, including 55 in read-only mode before category filtering.** Dedicated tools cover dashboards, topology, client/log diagnostics, DHCP reservations, VPN status, Wi-Fi, VLANs, firewall, routes, port forwarding, switch ports and device/client actions.
- **Traffic, RF and WAN diagnostics.** Bounded history and timestamped evidence distinguish missing metrics, partial results and truncation. See [network workflows](docs/network-workflows.md).
- **MSP, OpenAPI 3.1 and files.** Explicit MSP scope, JSON Schema 2020 validation and opt-in bounded multipart uploads/binary downloads. See [file transfers](docs/file-transfers.md).
- **Guarded configuration changes.** Discovered writes default to validated previews. Radio, DHCP, SSID, switch-port, rate-limit profile and log-notification writes retain dedicated safeguards. Rate-limit profile changes include drift-checked rollback receipts. Other discovered writes explicitly report that they have not been verified by reading settings back.
- **Wi-Fi audit snapshots and scoped tools.** Compare AP radio configuration across matching snapshots with [Wi-Fi audits](docs/wifi-audit.md), and limit dedicated/discovered operations with [category scopes](docs/scoped-tools.md).
- **Explicit read-only access.** `MCP_TOOL_PROFILE=read-only` blocks writes, including discovered operations. Controller permissions still govern which data is accessible.
- **Two API surfaces.** The official Omada Open API, plus the controller's internal web UI API for features the Open API doesn't expose (ACLs, routes, port forwarding on OC200).
- **OAuth and web authentication.** Open API client credentials or Fusion gateway web-session auth, with optional web UI credentials for internal-API tools. Private controller CAs are supported without disabling TLS verification.
- **stdio or HTTP.** Streamable HTTP and SSE transports, health checks, CORS, and optional ngrok tunnelling.
- **WAN failover guard.** An optional companion process that fixes Omada's Link Backup not failing over when a cable modem hands out a private fallback lease. See [docs/wan-guard.md](docs/wan-guard.md).
- **Know what's running.** `getServerInfo` reports the exact version and git commit of the running server.

## Quick start

### 1. Create Open API credentials

In your Omada controller, go to **Settings → Platform Integration → Open API**, add an application in **Client** mode, and note the **Client ID**, **Client Secret**, and **Omada ID** (`omadacId`).

> Tools that use the internal web UI API (`listRoutes`, route/port-forward CRUD, firewall ACLs on OC200) also need `OMADA_WEB_USERNAME` / `OMADA_WEB_PASSWORD` for a local controller account. Fusion gateways without Platform Integration can use `OMADA_AUTH_MODE=web` instead of OAuth.

### 2. Add it to your MCP client

**Docker (recommended)**, e.g. `claude_desktop_config.json` or `.mcp.json`:

```json
{
    "mcpServers": {
        "omada": {
            "command": "docker",
            "args": [
                "run",
                "-i",
                "--rm",
                "-e",
                "OMADA_BASE_URL",
                "-e",
                "OMADA_CLIENT_ID",
                "-e",
                "OMADA_CLIENT_SECRET",
                "-e",
                "OMADA_OMADAC_ID",
                "-e",
                "OMADA_SITE_ID",
                "-e",
                "OMADA_STRICT_SSL",
                "ghcr.io/realtydev/omada-mcp:latest"
            ],
            "env": {
                "OMADA_BASE_URL": "https://omada.local:8043",
                "OMADA_CLIENT_ID": "your-client-id",
                "OMADA_CLIENT_SECRET": "your-client-secret",
                "OMADA_OMADAC_ID": "your-omadac-id",
                "OMADA_SITE_ID": "your-site-id",
                "OMADA_STRICT_SSL": "false"
            }
        }
    }
}
```

**Claude Code:**

```bash
claude mcp add omada \
  -e OMADA_BASE_URL=https://omada.local:8043 \
  -e OMADA_CLIENT_ID=your-client-id \
  -e OMADA_CLIENT_SECRET=your-client-secret \
  -e OMADA_OMADAC_ID=your-omadac-id \
  -e OMADA_STRICT_SSL=false \
  -- docker run -i --rm \
     -e OMADA_BASE_URL -e OMADA_CLIENT_ID -e OMADA_CLIENT_SECRET -e OMADA_OMADAC_ID -e OMADA_STRICT_SSL \
     ghcr.io/realtydev/omada-mcp:latest
```

**From source:**

```bash
git clone https://github.com/realtydev/omada-mcp.git && cd omada-mcp
corepack enable && yarn install && yarn build
# then point your client at: node /path/to/omada-mcp/dist/index.js
```

### 3. Or run it as a shared HTTP server

```bash
docker run -d --env-file .env \
  -e MCP_SERVER_USE_HTTP=true -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -p 127.0.0.1:3000:3000 ghcr.io/realtydev/omada-mcp:latest
```

Endpoints: `http://localhost:3000/mcp` (Streamable HTTP) or `/sse` (SSE), with `/healthz` for health checks. See [README.Docker.md](README.Docker.md) for every HTTP option.

## Configuration

### Omada Controller

| Variable                   | Required   | Default       | Description                                                                |
| -------------------------- | ---------- | ------------- | -------------------------------------------------------------------------- |
| `OMADA_BASE_URL`           | Yes        | -             | Omada controller URL                                                       |
| `OMADA_AUTH_MODE`          | No         | `oauth`       | `oauth` for classic OpenAPI credentials, `web` for Fusion web-session auth |
| `OMADA_CLIENT_ID`          | OAuth mode | -             | OAuth client ID                                                            |
| `OMADA_CLIENT_SECRET`      | OAuth mode | -             | OAuth client secret                                                        |
| `OMADA_OMADAC_ID`          | Yes        | -             | Controller ID (omadacId)                                                   |
| `OMADA_MSP_ID`             | No         | —             | Explicit MSP context for discovered MSP routes                             |
| `OMADA_AUTH_ID`            | No         | Controller ID | Optional separate OAuth credential principal                               |
| `OMADA_SITE_ID`            | No         | -             | Default site ID                                                            |
| `OMADA_WEB_USERNAME`       | Web mode   | -             | Omada web UI username                                                      |
| `OMADA_WEB_PASSWORD`       | Web mode   | -             | Omada web UI password                                                      |
| `OMADA_STRICT_SSL`         | No         | `true`        | SSL certificate and hostname verification                                  |
| `OMADA_CA_FILE`            | No         | —             | PEM CA file/bundle added to default trust; requires strict SSL             |
| `OMADA_API_SPEC`           | No         | `auto`        | API discovery source: `auto`, `live`, or `bundled`                         |
| `OMADA_TRANSFER_DIR`       | No         | Disabled      | Existing private directory for file transfers                              |
| `OMADA_MAX_TRANSFER_BYTES` | No         | `16777216`    | Maximum combined upload bytes or download size, up to 64 MiB               |
| `OMADA_TIMEOUT`            | No         | `30000`       | Request timeout (ms)                                                       |

For Fusion gateways that do not expose Platform Integration OAuth credentials, set `OMADA_AUTH_MODE=web` and provide `OMADA_WEB_USERNAME` / `OMADA_WEB_PASSWORD`. The server logs in through `/{omadacId}/api/v2/login` and uses that web session for OpenAPI requests.

### MCP Server

| Variable                           | Required | Default     | Description                                                                  |
| ---------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------- |
| `MCP_SERVER_LOG_LEVEL`             | No       | `info`      | `debug`, `info`, `warn`, `error`, `silent`                                   |
| `MCP_SERVER_LOG_FORMAT`            | No       | `plain`     | `plain`, `json`, `gcp-json`                                                  |
| `MCP_SERVER_USE_HTTP`              | No       | `false`     | Enable HTTP transport                                                        |
| `MCP_TOOL_PROFILE`                 | No       | `full`      | `full` or `read-only`; read-only excludes writes and generic calls           |
| `MCP_TOOL_CATEGORIES`              | No       | —           | Optional category permissions, e.g. `all:r,wireless:rw`; see scoped profiles |
| `MCP_HTTP_SESSION_IDLE_TIMEOUT_MS` | No       | `1800000`   | Idle session lifetime; positive integer milliseconds                         |
| `MCP_HTTP_MAX_SESSIONS`            | No       | `100`       | Maximum retained and initializing HTTP/SSE sessions                          |
| `MCP_SERVER_STATEFUL`              | No       | `false`     | Stateful sessions                                                            |
| `MCP_HTTP_PORT`                    | No       | `3000`      | HTTP port                                                                    |
| `MCP_HTTP_TRANSPORT`               | No       | `stream`    | `stream` or `sse`                                                            |
| `MCP_HTTP_BIND_ADDR`               | No       | `127.0.0.1` | Bind address                                                                 |

## Tools

### Read Tools

| Tool                            | Description                                                                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `listSites`                     | List all sites on the controller                                                                                                                                    |
| `listDevices`                   | List devices for a site                                                                                                                                             |
| `listClients`                   | List active clients for a site                                                                                                                                      |
| `getDevice`                     | Get details for a specific device                                                                                                                                   |
| `getGatewayWanStatus`           | Live per-port WAN status: link/internet state, IPv4 lease, DNS, latency and loss                                                                                    |
| `getApRadios`                   | AP radio configuration (channel, width, tx power per band) and radio statistics (retries, drops)                                                                    |
| `getApRfScanResults`            | Latest AP RF scan results through Open API v2; reads existing results without starting a scan                                                                       |
| `getApAfcStatus`                | AFC status for supported 6 GHz APs; requires compatible controller and AP firmware                                                                                  |
| `getApAvailableChannels`        | Allowed radio channels and controller channel indices for use with `setApRadio`                                                                                     |
| `getSiteTopology`               | Controller-discovered topology, uplinks and link speeds; requires web UI credentials                                                                                |
| `getSiteDashboard`              | Wi-Fi, traffic, wireless retry/drop averages, switch and PoE summaries with explicit partial results                                                                |
| `getTrafficHistory`             | Bounded timestamped AP/switch traffic history                                                                                                                       |
| `getWifiHistory`                | Channel, interference, retry/drop and optional mesh evidence                                                                                                        |
| `diagnoseWan`                   | Gateway WAN status, ISP history and health evidence                                                                                                                 |
| `listVpnConnections`            | Paginated tunnel/IPsec or protocol-filtered site-to-site, server and client VPN status                                                                              |
| `getGatewayWanSpeedTestResults` | Read saved gateway WAN speed-test results without starting a test                                                                                                   |
| `listDhcpReservations`          | Read all DHCP reservation pages, optionally filtered by search text                                                                                                 |
| `diagnoseClient`                | Combine client attachment, device, topology and history evidence with explicit completeness and staleness                                                           |
| `diagnoseLogs`                  | Combine bounded alert/event samples for an explicit time window, preserving failures and truncation                                                                 |
| `diagnoseWifi`                  | Audit bounded Wi-Fi evidence and compare portable radio-configuration snapshots, with explicit missing/stale data                                                   |
| `getClientHistory`              | A client's association sessions over a time range, optionally with roams between APs                                                                                |
| `getClient`                     | Get details for a specific client                                                                                                                                   |
| `getSwitchStackDetail`          | Get switch stack configuration and status                                                                                                                           |
| `searchDevices`                 | Search devices globally across all sites                                                                                                                            |
| `listDevicesStats`              | Device statistics with pagination and filtering                                                                                                                     |
| `listMostActiveClients`         | Top clients sorted by traffic                                                                                                                                       |
| `listClientsActivity`           | Client activity time-series data                                                                                                                                    |
| `listClientsPastConnections`    | Historical client connections                                                                                                                                       |
| `getThreatList`                 | Security threat list with filtering                                                                                                                                 |
| `getInternetInfo`               | Internet / WAN configuration                                                                                                                                        |
| `getPortForwardingStatus`       | Port forwarding rules (User uses the internal web UI API when `OMADA_WEB_USERNAME`/`OMADA_WEB_PASSWORD` are set; UPnP uses the public Open API)                     |
| `getLanNetworkList`             | LAN networks and VLAN settings                                                                                                                                      |
| `getLanProfileList`             | LAN profiles for switch ports                                                                                                                                       |
| `getWlanGroupList`              | WLAN groups                                                                                                                                                         |
| `getSsidList`                   | SSIDs in a WLAN group                                                                                                                                               |
| `getSsidDetail`                 | Detailed SSID configuration                                                                                                                                         |
| `getFirewallSetting`            | Firewall rules and policies                                                                                                                                         |
| `getIpsSetting`                 | IDS/IPS (threat protection) status for a site's gateway — enabled/disabled, mode, and detection level; reports `supported: false` on gateway models without IDS/IPS |
| `getFirmwareDetails`            | Firmware info for a device                                                                                                                                          |
| `listAlerts`                    | Paginated site alerts, optionally filtered by module and resolved state                                                                                             |
| `listEvents`                    | Paginated site events, optionally filtered by module and event key prefix                                                                                           |
| `listLogs`                      | Paginated site logs                                                                                                                                                 |
| `listFirewallAcls`              | Firewall ACL rules                                                                                                                                                  |
| `listIpGroups`                  | IP groups used by firewall ACLs (internal web UI API, requires `OMADA_WEB_USERNAME`/`OMADA_WEB_PASSWORD`)                                                           |
| `listRoutes`                    | Static routes (internal web UI API only, requires `OMADA_WEB_USERNAME`/`OMADA_WEB_PASSWORD`)                                                                        |
| `getSwitch`                     | Full switch info including portList array (per-port status, profile, PoE)                                                                                           |
| `listSwitchPorts`               | Site-wide switch port telemetry (link, speed, traffic, STP, LLDP and PoE), optionally filtered by switch MAC; supports Agile Series switches                        |
| `getCableTestResults`           | Cable test results for a switch                                                                                                                                     |
| `getSwitchNetworks`             | Switch VLAN trunking configuration                                                                                                                                  |

`listSwitchPorts` was verified by the contributor on Software Controller 6.2.14.11 with an ES206GP v1.20. The endpoint is absent from the bundled API snapshot; older controllers may not support it. Gateway-integrated switch ports (such as ER7212PC) may return an empty list, as [reported in TP-Link's community](https://community.tp-link.com/en/business/forum/topic/860490). It is not a universal gateway PoE reader. Live validation on OC200 / Controller 6.3.0.45 returned 28 ports from SG2210XMP-M2 and SG2218P switches; the non-PoE SG3210X-M2 was absent from this endpoint. An empty filtered result therefore does not prove that the switch has no ports.

The AP diagnostics use the bundled `docs/openapi/03-device.json` operations `getRFScanResultV2`, `getAfcInfo`, and `getAvailableChannelOfAp`. Results and availability depend on controller and AP firmware. Unsupported-device errors are returned to the caller. RF results may be empty or stale until a scan has been run through the controller; these tools do not start scans or change radio settings. All three AP diagnostic tools were validated through MCP on two EAP773(US) v2.0 APs and an EAP772-Outdoor(US) v1.0, running firmware 1.5.5 with Controller 6.3.0.45. RF status 1 correctly reported no saved scan; the outdoor AP returned AFC working status and a future expiry, while indoor APs without AFC support returned status false.

### Write Tools

| Tool                     | Description                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `createLanNetwork`       | Create a LAN network (VLAN, subnet, DHCP range, DNS servers, custom DHCP options)                                        |
| `updateLanNetwork`       | Update a LAN network                                                                                                     |
| `deleteLanNetwork`       | Delete a LAN network                                                                                                     |
| `createLanProfile`       | Create a LAN profile                                                                                                     |
| `updateLanProfile`       | Update a LAN profile                                                                                                     |
| `updateFirewallSetting`  | Update firewall settings                                                                                                 |
| `setIpsSetting`          | Enable/disable and configure IDS/IPS (mode, detection level) on a site's gateway; can reduce max throughput when enabled |
| `createFirewallAcl`      | Create a firewall ACL rule                                                                                               |
| `updateFirewallAcl`      | Update a firewall ACL rule                                                                                               |
| `deleteFirewallAcl`      | Delete a firewall ACL rule                                                                                               |
| `updateSsid`             | Preserve SSID settings with typed partial updates, redacted previews and read-back verification                          |
| `setSsidEnable`          | Enable or disable an SSID network-wide                                                                                   |
| `updateSwitchPort`       | Guarded profile or PoE update (one setting); unsupported generic settings are rejected                                   |
| `updateClient`           | Update name, fixed IPv4 or rate limits through setting-specific endpoints; supports dry-run previews                     |
| `updateRateLimitProfile` | Partial profile updates with previews, preservation, read-back verification and rollback receipts                        |
| `rollbackNetworkChange`  | Restore a verified rate-limit profile change after checking for drift                                                    |
| `setSwitchNetworks`      | Set switch VLAN trunking configuration                                                                                   |
| `createRoute`            | Create a static route (internal web UI API only)                                                                         |
| `updateRoute`            | Update a static route by ID (internal web UI API only)                                                                   |
| `deleteRoute`            | Delete a static route by ID (internal web UI API only)                                                                   |
| `createPortForward`      | Create a port forwarding rule (internal web UI API only)                                                                 |
| `updatePortForward`      | Update a port forwarding rule by ID (internal web UI API only)                                                           |
| `deletePortForward`      | Delete a port forwarding rule by ID (internal web UI API only)                                                           |
| `updateWanPortSetting`   | Update a gateway WAN port's IPv4/IPv6/MAC connection settings (e.g. DHCP client `unicastDhcp`)                           |
| `createDhcpReservation`  | Create a MAC/IP reservation with preview and bounded read-back verification                                              |
| `updateDhcpReservation`  | Patch reservation settings while preserving other writable fields; preview and no-op detection                           |
| `deleteDhcpReservation`  | Remove a reservation with preview and verified absence after deletion                                                    |

DHCP writes support `dryRun`. Inspect `verification.status`: `verified` confirms the observed result, `mismatch` means the desired state was not observed, and `unknown` means verification could not establish the outcome. A lost write response is reconciled with reads; the tool does not replay an uncertain mutation. `written: "unknown"` is not a confirmed success.

### Switch Port Tools

| Tool                           | Description                                      |
| ------------------------------ | ------------------------------------------------ |
| `setSwitchPortProfile`         | Assign a LAN profile to a single port            |
| `setSwitchPortPoe`             | Enable/disable PoE on a single port              |
| `setSwitchPortName`            | Set name on a single port                        |
| `setSwitchPortStatus`          | Enable/disable a single port                     |
| `setSwitchPortProfileOverride` | Enable/disable profile override on a single port |
| `batchSetSwitchPortProfile`    | Batch profile override on multiple ports         |
| `batchSetSwitchPortPoe`        | Batch PoE on multiple ports                      |
| `batchSetSwitchPortStatus`     | Batch enable/disable multiple ports              |
| `batchSetSwitchPortName`       | Batch set names on multiple ports                |
| `startCableTest`               | Start cable test on a switch                     |

### Action Tools

| Tool                   | Description                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rebootDevice`         | Reboot a device                                                                                                                                                                                            |
| `adoptDevice`          | Start adopting one device, with optional device username/password                                                                                                                                          |
| `blockClient`          | Block a client                                                                                                                                                                                             |
| `unblockClient`        | Unblock a client                                                                                                                                                                                           |
| `reconnectClient`      | Reconnect a client                                                                                                                                                                                         |
| `setDeviceLed`         | Deprecated: returns unsupported; choose `locateDevice` or `setSiteLed` explicitly                                                                                                                          |
| `locateDevice`         | Start or stop blinking a single device for identification                                                                                                                                                  |
| `setSiteLed`           | Enable or disable device LEDs across the whole site                                                                                                                                                        |
| `setLogNotifications`  | Turn alert/event log notification types on or off for a site; dry run supported, returns a before/after diff (live config write)                                                                           |
| `setApRadio`           | Change one AP radio band: enable, channel index, width, tx power. Reads back and verifies, fails if the controller does not apply it; dry run supported (live config write, can drop clients on that band) |
| `startFirmwareUpgrade` | Start firmware upgrade                                                                                                                                                                                     |
| `setGatewayWanConnect` | Software-connect or disconnect a gateway WAN port                                                                                                                                                          |

### Generic

| Tool                   | Description                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `genericApiCall`       | Invoke any Omada OpenAPI endpoint directly                                               |
| `searchApiOperations`  | Search API operations by keyword, category or HTTP method                                |
| `describeApiOperation` | Inspect an operation’s parameters, schemas and limitations                               |
| `executeApiOperation`  | Execute validated JSON, multipart or file-download operations; writes preview by default |

See [network workflows](docs/network-workflows.md) for diagnostics and verified profile rollback, and [file transfers](docs/file-transfers.md) for bounded upload/download configuration.

### Meta

| Tool                        | Description                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `getServerInfo`             | Report the package version, git commit, and build time this server process was actually built from      |
| `getControllerCapabilities` | Read controller metadata and API documentation evidence; optionally inspect one SSID for missing fields |

Automatic discovery keeps the existing tools and adds searchable API coverage. See [API discovery](docs/api-discovery.md) for source selection, write previews, read-only enforcement and pagination limits.

## Reliability and tool exposure

Concurrent requests share OAuth renewal and web/internal logins. Responses from an invalidated login cannot overwrite newer credentials, and a late authentication error cannot clear a newer token. Authentication retries are bounded and retain controller error details.

Controller requests share pacing across the public and internal APIs. GET/HEAD requests can retry transient failures twice within the request timeout, respecting bounded `Retry-After` delays; mutations are not retried for transient failures. Forbidden operations preserve the valid session, while explicit expiry still renews it. Rejected credentials enter a short cooldown to reduce repeated failed logins.

`updateSsid` accepts partial basic-configuration fields and preserves required settings and nested security fields from the current SSID. Use `dryRun:true` to preview redacted changes. The default remains to apply. Inspect `verification.status`, `unexpectedChanges` and `unverifiedPreservedFields`; masked preserved values are identified explicitly. `written:"unknown"` means the write response was lost and the outcome was reconciled with reads without replaying the write. If the controller masks an existing WPA-Personal key, provide its actual value before applying a preserving update. Detected configuration drift stops the write; concurrent edits after the final read remain possible because conditional writes are not established.

Some controller detail responses omit required update fields such as `mloEnable`. Supply those fields explicitly; the tool does not infer a disabled setting from missing data. If readback also omits a requested field, verification reports `unknown`. Guarded live validation confirmed preview behavior with an explicit MLO value; no SSID changes were applied.

Switch-port tools provide previews, preflight checks and per-port configuration readback. PoE requires affirmative support evidence and an enabled override; explicit disruption risks require caller intent. See [switch safety](docs/switch-safety.md) for blockers, unknown evidence and supported settings. [Controller capabilities](docs/controller-capabilities.md) separates metadata, API documentation and one optional SSID sample from verified hardware support.

Set `MCP_TOOL_PROFILE=read-only` to expose read tools and diagnostics while excluding writes and `genericApiCall`. The default `full` profile preserves the full tool catalogue. The profile controls exposed operations; controller credentials and permissions still determine API access.

Use `MCP_TOOL_CATEGORIES=all:r,wireless:rw` to read across known categories and allow wireless writes only. Category-specific permissions, the global read-only profile and per-server restrictions intersect across dedicated tools, discovery and raw API calls. Invalid/empty scopes and unclassified routes fail closed. See [scoped tool profiles](docs/scoped-tools.md).

`diagnoseWifi` collects bounded dashboard, radio and saved-RF evidence without starting scans. Save its `snapshot` and pass it as `baseline` for a scope-matched configuration comparison. Missing data is explicit; unchanged configuration does not establish good performance. See [Wi-Fi audit](docs/wifi-audit.md).

HTTP/SSE sessions default to a 30-minute idle timeout (`MCP_HTTP_SESSION_IDLE_TIMEOUT_MS=1800000`) and a limit of 100 sessions (`MCP_HTTP_MAX_SESSIONS=100`). Capacity includes sessions being initialized. Full capacity returns HTTP 503 with a retry hint. Active tool calls are protected from idle expiry; keeping an event stream open alone does not keep a session alive. SSE accepts the SDK's `sessionId` query parameter as well as the legacy session header.

`getSiteDashboard` defaults to the last hour and accepts epoch-second `start`/`end` windows up to 24 hours. PoE is a current snapshot. Results cap each device list at 50 and mark truncation or unavailable sections explicitly; wireless charts and per-port details are omitted. Units are controller-defined: Wi-Fi traffic KB, per-device traffic MB, switch traffic bytes, PoE watts.

Topology is the controller's discovered view and can omit unmanaged hops. Client diagnostics report unavailable sections, topology age, and unresolved paths explicitly. Log diagnostics return bounded samples and identify truncation; an incomplete result is not a clean bill of health. VPN `s2s`, `server`, and `client` queries require a controller protocol code in `vpnType` (for example, IPsec site-to-site uses `2`). Saved speed results may be absent until a test has been run separately. These new reads and DHCP reservation CRUD were validated on OC200 / Controller 6.3.0.45 with an ER8411. The DHCP test used a disabled synthetic reservation and verified its removal. VPN status was validated with empty connection tables; no VPN configuration was created.

## WAN failover guard

Omada's Link Backup can stay stuck on a dead primary WAN when the cable modem hands the gateway a private fallback lease (e.g. `192.168.100.10`) and Online Detection keeps calling it "online". The optional guard polls `getGatewayWanStatus` and software-disconnects only the primary port after consecutive fallback observations, so Link Backup takes over.

```bash
OMADA_WAN_GUARD_ENABLED=true OMADA_WAN_GUARD_GATEWAY_MAC=AA-BB-CC-DD-EE-FF yarn wan-guard
```

It is disabled and dry-run by default. Read [docs/wan-guard.md](docs/wan-guard.md) for configuration, testing, and where to host it.

## Safety

This server can change live network configuration. Some good habits:

- Give the MCP client an Open API app scoped to what you need; use a **viewer** role if you only want read tools.
- Keep `OMADA_STRICT_SSL=true`. For a private CA or self-signed controller, set `OMADA_CA_FILE` to its trusted PEM certificate/bundle. Requests do not follow redirects; configure the controller's final URL directly.
- Leave `MCP_HTTP_BIND_ADDR` at `127.0.0.1` unless you put the HTTP server behind authentication. The MCP endpoint itself is unauthenticated.
- Ask your assistant to use dry runs where available, and to read settings back after writes.

Found a vulnerability? See [SECURITY.md](SECURITY.md).

## Development

Requires Node 24 (see `.nvmrc`, use `nvm use`) and [Yarn 4](https://yarnpkg.com/) via Corepack (`corepack enable`).

```bash
yarn install
yarn dev          # Live reload via tsx
yarn build        # Compile TypeScript
yarn check        # Lint + type check
yarn start        # Run compiled server (stdio)
```

### Read-only hardware smoke test

After `yarn build`, run `yarn smoke:readonly` with your local controller configuration. It exercises real MCP calls, reports counts and capability status without printing device identifiers or credentials, and blocks configuration writes at the HTTP boundary. Authentication is the only permitted POST. It also blocks cross-origin requests and redirects. Exit codes: `0` passed, `1` failed, `2` a capability was unavailable. It does not start RF scans or speed tests.

### Docker

```bash
yarn docker:build   # Build image
yarn docker:run     # Run with .env file
```

### Restarting after a change

For stdio transport, each session's MCP client spawns its own server subprocess when it connects,
and that process keeps running whatever code it loaded at that point. Rebuilding `dist/` on disk
(`yarn build`) does **not** affect an already-connected session — only a fresh connection picks up
the new build. After merging a change and rebuilding:

1. Restart/reconnect each MCP session that talks to this server (e.g. `/mcp` in Claude Code, or
   start a new session).
2. Call the `getServerInfo` tool and check `gitCommit` against the commit you expect to be running,
   before relying on any new or changed tool behavior — especially anything billed as dry-run or
   safe-by-default. A session that skips this can silently keep running stale code that ignores a
   safety parameter it doesn't know about yet.

## Feature direction

[Omada 6.3 release notes](https://static.tp-link.com/upload/software/2026/202609/20260904/Omada%20Software%20Controller%20v6.3.0%20Release%20Note.pdf) introduce incident detection, wired-client health, and richer wireless health metrics. Useful next additions are:

- Read-only incident and health summaries that preserve the controller's scores and firmware requirements. Verify API contracts before implementing these newer surfaces.
- Wireless security visibility: rogue APs and WIDS detections, starting with the endpoints already described in `docs/openapi/09-insight.json`.
- Client-path diagnostics combining device, switch-port and LLDP telemetry to explain where a client connects and where a link is unhealthy.
- Broader configuration previews and read-back verification, extending the existing radio dry-run pattern one operation at a time.

These are follow-up concepts, not advertised tools. The Fusion web-session expiry issue [#14](https://github.com/realtydev/omada-mcp/issues/14) still needs a sanitized real expired-session response before a controller-specific retry code can be added reliably.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup and conventions. Much of this codebase is written with AI assistance (Claude Code) under human review.

## Credits

Maintained by [realtydev](https://github.com/realtydev).

- Originally created by [João Miguel Tabosa Vaz Marques Silva](https://github.com/MiguelTVMS) as [tplink-omada-mcp](https://github.com/MiguelTVMS/tplink-omada-mcp).
- [@JimmyMultani](https://github.com/JimmyMultani) contributed route and port-forward CRUD, SSID and AP radio writes, IDS/IPS, alerts, client history, `getServerInfo`, strict write validation, and many endpoint fixes.
- [@bullitt186](https://github.com/bullitt186) contributed Fusion gateway web-session auth.

## License

[MIT](LICENSE)
