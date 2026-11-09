# TP-Link Omada MCP Server

A Model Context Protocol (MCP) server that exposes TP-Link Omada controller APIs to AI copilots and automation workflows. This Docker image provides an easy way to run the MCP server with support for both stdio and HTTP transports.

## Quick Start

### Using with Claude Desktop (stdio)

1. **Pull the Docker image**:

   ```bash
   docker pull ghcr.io/realtydev/omada-mcp:latest
   ```

2. **Add the MCP server to Claude Desktop configuration**. Edit your Claude Desktop config file:
   - **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

3. **Add the following configuration**:

   ```json
   {
     "mcpServers": {
       "tplink-omada": {
         "command": "docker",
         "args": [
           "run",
           "-i",
           "--rm",
           "-e", "OMADA_BASE_URL=https://your-omada-controller.local",
           "-e", "OMADA_CLIENT_ID=your-client-id",
           "-e", "OMADA_CLIENT_SECRET=your-client-secret",
           "-e", "OMADA_OMADAC_ID=your-omadac-id",
           "-e", "OMADA_SITE_ID=your-site-id",
           "-e", "OMADA_STRICT_SSL=false",
           "ghcr.io/realtydev/omada-mcp:latest"
         ]
       }
     }
   }
   ```

   Replace the environment variable values with your actual Omada controller credentials.

4. **Restart Claude Desktop** to load the new MCP server configuration.

5. **Verify the connection** by asking Claude to list your Omada sites or devices.

### Using Docker Containers

#### CLI/stdio Container

```bash
docker run -it --rm \
  --env-file .env \
  ghcr.io/realtydev/omada-mcp:latest
```

#### HTTP Server Container

```bash
docker run -d \
  --env-file .env \
  -e MCP_SERVER_USE_HTTP=true \
  -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -p 3000:3000 \
  ghcr.io/realtydev/omada-mcp:latest
```

The HTTP server will be available at `http://localhost:3000/mcp` (stream transport) or `http://localhost:3000/sse` (SSE transport).

## Features

- OAuth client-credentials authentication with automatic token refresh, plus web-session authentication for Fusion gateways
- 91 tools for reading telemetry and managing sites, devices, clients, VLANs, firewall rules, SSIDs and switch ports
- Generic Omada API invoker for advanced automation scenarios
- Environment-driven configuration
- Support for both stdio and HTTP transports
- Multi-platform support (linux/amd64, linux/arm64)

## Configuration

The MCP server reads its configuration from environment variables.

### Omada Controller

| Variable              | Required   | Default | Description                                                                |
| --------------------- | ---------- | ------- | -------------------------------------------------------------------------- |
| `OMADA_BASE_URL`      | Yes        | -       | Omada controller URL                                                       |
| `OMADA_AUTH_MODE`     | No         | `oauth` | `oauth` for classic OpenAPI credentials, `web` for Fusion web-session auth |
| `OMADA_CLIENT_ID`     | OAuth mode | -       | OAuth client ID                                                            |
| `OMADA_CLIENT_SECRET` | OAuth mode | -       | OAuth client secret                                                        |
| `OMADA_OMADAC_ID`     | Yes        | -       | Controller ID (omadacId)                                                   |
| `OMADA_SITE_ID`       | No         | -       | Default site ID                                                            |
| `OMADA_WEB_USERNAME`  | Web mode   | -       | Omada web UI username                                                      |
| `OMADA_WEB_PASSWORD`  | Web mode   | -       | Omada web UI password                                                      |
| `OMADA_STRICT_SSL`    | No         | `true`  | SSL verification (`false` for self-signed)                                 |
| `OMADA_TIMEOUT`       | No         | `30000` | Request timeout (ms)                                                       |

For Fusion gateways that do not expose Platform Integration OAuth credentials, set `OMADA_AUTH_MODE=web` and provide `OMADA_WEB_USERNAME` / `OMADA_WEB_PASSWORD`. The server logs in through `/{omadacId}/api/v2/login` and uses that web session for OpenAPI requests.

### MCP Generic Server Configuration

| Variable                           | Required | Default   | Description                                                           |
| ---------------------------------- | -------- | --------- | --------------------------------------------------------------------- |
| `MCP_SERVER_LOG_LEVEL`             | No       | `info`    | Logging verbosity (`debug`, `info`, `warn`, `error`, `silent`)        |
| `MCP_SERVER_LOG_FORMAT`            | No       | `plain`   | Log output format (`plain`, `json`, or `gcp-json`)                    |
| `MCP_SERVER_USE_HTTP`              | No       | `false`   | Start HTTP server instead of stdio                                    |
| `MCP_TOOL_PROFILE`                 | No       | `full`    | `full` or `read-only`; excludes writes and generic calls in read-only |
| `MCP_HTTP_SESSION_IDLE_TIMEOUT_MS` | No       | `1800000` | Positive integer idle session lifetime in milliseconds                |
| `MCP_HTTP_MAX_SESSIONS`            | No       | `100`     | Maximum retained and initializing HTTP/SSE sessions                   |
| `MCP_SERVER_STATEFUL`              | No       | `false`   | Maintain stateful sessions per client                                 |

### MCP Server HTTP Configuration

These variables are only used when `MCP_SERVER_USE_HTTP=true`:

| Variable                      | Required | Default                | Description                                                                             |
| ----------------------------- | -------- | ---------------------- | --------------------------------------------------------------------------------------- |
| `MCP_HTTP_PORT`               | No       | `3000`                 | Port for the HTTP server                                                                |
| `MCP_HTTP_TRANSPORT`          | No       | `stream`               | Transport protocol (`stream` or `sse`). See [Transport Protocols](#transport-protocols) |
| `MCP_HTTP_BIND_ADDR`          | No       | `127.0.0.1`            | Bind address (IPv4/IPv6). Use adapter IP address to expose to the network.              |
| `MCP_HTTP_PATH`               | No       | `/mcp` or `/sse`*      | Base path for MCP endpoints (*depends on transport)                                     |
| `MCP_HTTP_ENABLE_HEALTHCHECK` | No       | `true`                 | Enable a healthcheck endpoint                                                           |
| `MCP_HTTP_HEALTHCHECK_PATH`   | No       | `/healthz`             | Path for the healthcheck endpoint                                                       |
| `MCP_HTTP_ALLOW_CORS`         | No       | `true`                 | Enable CORS for the HTTP server                                                         |
| `MCP_HTTP_ALLOWED_ORIGINS`    | No       | `127.0.0.1, localhost` | Comma-separated list of allowed origins. Use `*` to allow all (dev only)                |
| `MCP_HTTP_NGROK_ENABLED`      | No       | `false`                | Use ngrok to expose the HTTP server publicly                                            |
| `MCP_HTTP_NGROK_AUTH_TOKEN`   | No       | -                      | Ngrok auth token (required if `MCP_HTTP_NGROK_ENABLED=true`)                            |

Create a `.env` file or export the variables before launching the container.

## Transport Protocols

The MCP server supports two HTTP transport protocols:

### Streamable HTTP (Default)

The **Streamable HTTP** transport implements the [MCP protocol version 2025-03-26](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#http-with-sse). This is the recommended transport for new integrations.

```bash
docker run -d \
  --env-file .env \
  -e MCP_SERVER_USE_HTTP=true \
  -e MCP_HTTP_TRANSPORT=stream \
  -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -p 3000:3000 \
  ghcr.io/realtydev/omada-mcp:latest
```

Features:

- Single endpoint for all operations (GET, POST, DELETE)
- Server-Sent Events for streaming responses
- Built-in session management with cryptographic session IDs
- Support for stateless mode when needed

The Streamable HTTP endpoint defaults to `/mcp` and handles:

- `GET /mcp` - Establish SSE stream and initialize session
- `POST /mcp` - Send JSON-RPC messages
- `DELETE /mcp` - Terminate session

### HTTP with SSE (Legacy)

The **HTTP+SSE** transport implements the [MCP protocol version 2024-11-05](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports#http-with-sse). This transport is provided for backward compatibility with older MCP clients.

```bash
docker run -d \
  --env-file .env \
  -e MCP_SERVER_USE_HTTP=true \
  -e MCP_HTTP_TRANSPORT=sse \
  -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -p 3000:3000 \
  ghcr.io/realtydev/omada-mcp:latest
```

Features:

- Separate endpoints for SSE stream and POST messages
- Compatible with older MCP client implementations

The SSE transport uses two endpoints:

- `GET /sse` - Establish SSE connection
- `POST /messages` - Send JSON-RPC messages

### Security Considerations

Both transports implement DNS rebinding protection:

- **Origin Validation**: The server validates the `Origin` header on all incoming connections. Configure allowed origins with `MCP_HTTP_ALLOWED_ORIGINS` (default: `127.0.0.1, localhost`). Use `*` to allow all origins (development only, not recommended for production).
- **Network Binding**: The server binds to `127.0.0.1` by default, restricting access to localhost only. Set `MCP_HTTP_BIND_ADDR=0.0.0.0` to expose the server to your network (not recommended for production without additional security measures).

For more information on the MCP protocol and transports, see the [Model Context Protocol documentation](https://modelcontextprotocol.io/).

### Using ngrok

To share the local server with remote tooling, you can use ngrok to expose the HTTP server publicly. This works with **both stream and SSE transports**.

**Built-in ngrok support**

```bash
docker run -d \
  --env-file .env \
  -e MCP_SERVER_USE_HTTP=true \
  -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -e MCP_HTTP_NGROK_ENABLED=true \
  -e MCP_HTTP_NGROK_AUTH_TOKEN=your-ngrok-auth-token \
  -p 3000:3000 \
  ghcr.io/realtydev/omada-mcp:latest
```

The server will automatically establish an ngrok tunnel and log the public URL.

If an intermediary strips the `Mcp-Session-Id` header, set `MCP_SERVER_STATEFUL=false` to disable server-managed sessions and allow stateless requests.

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
| `listVpnConnections`            | Paginated tunnel/IPsec or protocol-filtered site-to-site, server and client VPN status                                                                              |
| `getGatewayWanSpeedTestResults` | Read saved gateway WAN speed-test results without starting a test                                                                                                   |
| `listDhcpReservations`          | Read all DHCP reservation pages, optionally filtered by search text                                                                                                 |
| `diagnoseClient`                | Combine client attachment, device, topology and history evidence with explicit completeness and staleness                                                           |
| `diagnoseLogs`                  | Combine bounded alert/event samples for an explicit time window, preserving failures and truncation                                                                 |
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

| Tool                    | Description                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `createLanNetwork`      | Create a LAN network (VLAN, subnet, DHCP range, DNS servers, custom DHCP options)                                        |
| `updateLanNetwork`      | Update a LAN network                                                                                                     |
| `deleteLanNetwork`      | Delete a LAN network                                                                                                     |
| `createLanProfile`      | Create a LAN profile                                                                                                     |
| `updateLanProfile`      | Update a LAN profile                                                                                                     |
| `updateFirewallSetting` | Update firewall settings                                                                                                 |
| `setIpsSetting`         | Enable/disable and configure IDS/IPS (mode, detection level) on a site's gateway; can reduce max throughput when enabled |
| `createFirewallAcl`     | Create a firewall ACL rule                                                                                               |
| `updateFirewallAcl`     | Update a firewall ACL rule                                                                                               |
| `deleteFirewallAcl`     | Delete a firewall ACL rule                                                                                               |
| `updateSsid`            | Update an SSID's basic config (name, band, security, VLAN, PSK, etc.)                                                    |
| `setSsidEnable`         | Enable or disable an SSID network-wide                                                                                   |
| `updateSwitchPort`      | Update switch port config (profile, PoE, speed, STP)                                                                     |
| `updateClient`          | Update client settings                                                                                                   |
| `setSwitchNetworks`     | Set switch VLAN trunking configuration                                                                                   |
| `createRoute`           | Create a static route (internal web UI API only)                                                                         |
| `updateRoute`           | Update a static route by ID (internal web UI API only)                                                                   |
| `deleteRoute`           | Delete a static route by ID (internal web UI API only)                                                                   |
| `createPortForward`     | Create a port forwarding rule (internal web UI API only)                                                                 |
| `updatePortForward`     | Update a port forwarding rule by ID (internal web UI API only)                                                           |
| `deletePortForward`     | Delete a port forwarding rule by ID (internal web UI API only)                                                           |
| `updateWanPortSetting`  | Update a gateway WAN port's IPv4/IPv6/MAC connection settings (e.g. DHCP client `unicastDhcp`)                           |
| `createDhcpReservation` | Create a MAC/IP reservation with preview and bounded read-back verification                                              |
| `updateDhcpReservation` | Patch reservation settings while preserving other writable fields; preview and no-op detection                           |
| `deleteDhcpReservation` | Remove a reservation with preview and verified absence after deletion                                                    |

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
| `adoptDevice`          | Adopt a device                                                                                                                                                                                             |
| `blockClient`          | Block a client                                                                                                                                                                                             |
| `unblockClient`        | Unblock a client                                                                                                                                                                                           |
| `reconnectClient`      | Reconnect a client                                                                                                                                                                                         |
| `setDeviceLed`         | Set device LED setting                                                                                                                                                                                     |
| `setLogNotifications`  | Turn alert/event log notification types on or off for a site; dry run supported, returns a before/after diff (live config write)                                                                           |
| `setApRadio`           | Change one AP radio band: enable, channel index, width, tx power. Reads back and verifies, fails if the controller does not apply it; dry run supported (live config write, can drop clients on that band) |
| `startFirmwareUpgrade` | Start firmware upgrade                                                                                                                                                                                     |
| `setGatewayWanConnect` | Software-connect or disconnect a gateway WAN port                                                                                                                                                          |

### Generic

| Tool             | Description                                |
| ---------------- | ------------------------------------------ |
| `genericApiCall` | Invoke any Omada OpenAPI endpoint directly |

### Meta

| Tool            | Description                                                                                        |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `getServerInfo` | Report the package version, git commit, and build time this server process was actually built from |

## Reliability and tool exposure

Concurrent requests share OAuth renewal and web/internal logins. Responses from an invalidated login cannot overwrite newer credentials, and a late authentication error cannot clear a newer token. Authentication retries are bounded and retain controller error details.

Set `MCP_TOOL_PROFILE=read-only` to expose read tools and diagnostics while excluding writes and `genericApiCall`. The default `full` profile preserves the full tool catalogue. The profile controls exposed operations; controller credentials and permissions still determine API access.

HTTP/SSE sessions default to a 30-minute idle timeout (`MCP_HTTP_SESSION_IDLE_TIMEOUT_MS=1800000`) and a limit of 100 sessions (`MCP_HTTP_MAX_SESSIONS=100`). Capacity includes sessions being initialized. Full capacity returns HTTP 503 with a retry hint. Active tool calls are protected from idle expiry; keeping an event stream open alone does not keep a session alive. SSE accepts the SDK's `sessionId` query parameter as well as the legacy session header.

Topology is the controller's discovered view and can omit unmanaged hops. Client diagnostics report unavailable sections, topology age, and unresolved paths explicitly. Log diagnostics return bounded samples and identify truncation; an incomplete result is not a clean bill of health. VPN `s2s`, `server`, and `client` queries require a controller protocol code in `vpnType` (for example, IPsec site-to-site uses `2`). Saved speed results may be absent until a test has been run separately. These new reads and DHCP reservation CRUD were validated on OC200 / Controller 6.3.0.45 with an ER8411. The DHCP test used a disabled synthetic reservation and verified its removal. VPN status was validated with empty connection tables; no VPN configuration was created.

## Contributing

Want to help improve this project? Contributions are welcome! Visit our GitHub repository to report issues, suggest features, or submit pull requests:

**https://github.com/realtydev/omada-mcp**

## License

This project is licensed under the [MIT License](https://github.com/realtydev/omada-mcp/blob/main/LICENSE).
