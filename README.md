# Omada MCP Server

Full CRUD MCP server for TP-Link Omada SDN controllers. Exposes 70+ tools for reading, writing, and managing sites, devices, clients, networks, switch ports, firewalls, and more — all via the Model Context Protocol.

Most of this codebase is written by AI (Claude Code), with human review and direction.

## Quick Start

### Using with Claude Code / Claude Desktop (stdio)

Add to your MCP client configuration:

```json
{
  "mcpServers": {
    "omada": {
      "command": "node",
      "args": ["/path/to/omada-mcp/dist/index.js"],
      "env": {
        "OMADA_BASE_URL": "https://your-omada-controller.local",
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

### Using Docker

```json
{
  "mcpServers": {
    "omada": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "OMADA_BASE_URL=https://your-omada-controller.local",
        "-e", "OMADA_CLIENT_ID=your-client-id",
        "-e", "OMADA_CLIENT_SECRET=your-client-secret",
        "-e", "OMADA_OMADAC_ID=your-omadac-id",
        "-e", "OMADA_SITE_ID=your-site-id",
        "-e", "OMADA_STRICT_SSL=false",
        "jmtvms/tplink-omada-mcp:latest"
      ]
    }
  }
}
```

### Docker HTTP Server

```bash
docker run -d \
  --env-file .env \
  -e MCP_SERVER_USE_HTTP=true \
  -e MCP_HTTP_BIND_ADDR=0.0.0.0 \
  -p 3000:3000 \
  jmtvms/tplink-omada-mcp:latest
```

Available at `http://localhost:3000/mcp` (stream) or `http://localhost:3000/sse` (SSE).

## Environment Variables

### Omada Controller

| Variable | Required | Default | Description |
|---|---|---|---|
| `OMADA_BASE_URL` | Yes | - | Omada controller URL |
| `OMADA_CLIENT_ID` | Yes | - | OAuth client ID |
| `OMADA_CLIENT_SECRET` | Yes | - | OAuth client secret |
| `OMADA_OMADAC_ID` | Yes | - | Controller ID (omadacId) |
| `OMADA_SITE_ID` | No | - | Default site ID |
| `OMADA_STRICT_SSL` | No | `true` | SSL verification (`false` for self-signed) |
| `OMADA_TIMEOUT` | No | `30000` | Request timeout (ms) |

### MCP Server

| Variable | Required | Default | Description |
|---|---|---|---|
| `MCP_SERVER_LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `MCP_SERVER_LOG_FORMAT` | No | `plain` | `plain`, `json`, `gcp-json` |
| `MCP_SERVER_USE_HTTP` | No | `false` | Enable HTTP transport |
| `MCP_SERVER_STATEFUL` | No | `false` | Stateful sessions |
| `MCP_HTTP_PORT` | No | `3000` | HTTP port |
| `MCP_HTTP_TRANSPORT` | No | `stream` | `stream` or `sse` |
| `MCP_HTTP_BIND_ADDR` | No | `127.0.0.1` | Bind address |

## Tools

### Read Tools

| Tool | Description |
|---|---|
| `listSites` | List all sites on the controller |
| `listDevices` | List devices for a site |
| `listClients` | List active clients for a site |
| `getDevice` | Get details for a specific device |
| `getApRadios` | AP radio configuration (channel, width, tx power per band) and radio statistics (retries, drops) |
| `getClientHistory` | A client's association sessions over a time range, optionally with roams between APs |
| `getClient` | Get details for a specific client |
| `getSwitchStackDetail` | Get switch stack configuration and status |
| `searchDevices` | Search devices globally across all sites |
| `listDevicesStats` | Device statistics with pagination and filtering |
| `listMostActiveClients` | Top clients sorted by traffic |
| `listClientsActivity` | Client activity time-series data |
| `listClientsPastConnections` | Historical client connections |
| `getThreatList` | Security threat list with filtering |
| `getInternetInfo` | Internet / WAN configuration |
| `getPortForwardingStatus` | Port forwarding rules (User uses the internal web UI API when `OMADA_WEB_USERNAME`/`OMADA_WEB_PASSWORD` are set; UPnP uses the public Open API) |
| `getLanNetworkList` | LAN networks and VLAN settings |
| `getLanProfileList` | LAN profiles for switch ports |
| `getWlanGroupList` | WLAN groups |
| `getSsidList` | SSIDs in a WLAN group |
| `getSsidDetail` | Detailed SSID configuration |
| `getFirewallSetting` | Firewall rules and policies |
| `getIpsSetting` | IDS/IPS (threat protection) status for a site's gateway — enabled/disabled, mode, and detection level; reports `supported: false` on gateway models without IDS/IPS |
| `getFirmwareDetails` | Firmware info for a device |
| `listAlerts` | Paginated site alerts, optionally filtered by module and resolved state |
| `listEvents` | Paginated site events, optionally filtered by module and event key prefix |
| `listLogs` | Paginated site logs |
| `listFirewallAcls` | Firewall ACL rules |
| `listRoutes` | Static routes (internal web UI API only, requires `OMADA_WEB_USERNAME`/`OMADA_WEB_PASSWORD`) |
| `getSwitch` | Full switch info including portList array (per-port status, profile, PoE) |
| `getCableTestResults` | Cable test results for a switch |
| `getSwitchNetworks` | Switch VLAN trunking configuration |

### Write Tools

| Tool | Description |
|---|---|
| `createLanNetwork` | Create a LAN network |
| `updateLanNetwork` | Update a LAN network |
| `deleteLanNetwork` | Delete a LAN network |
| `createLanProfile` | Create a LAN profile |
| `updateLanProfile` | Update a LAN profile |
| `updateFirewallSetting` | Update firewall settings |
| `setIpsSetting` | Enable/disable and configure IDS/IPS (mode, detection level) on a site's gateway; can reduce max throughput when enabled |
| `createFirewallAcl` | Create a firewall ACL rule |
| `updateFirewallAcl` | Update a firewall ACL rule |
| `deleteFirewallAcl` | Delete a firewall ACL rule |
| `updateSsid` | Update an SSID's basic config (name, band, security, VLAN, PSK, etc.) |
| `setSsidEnable` | Enable or disable an SSID network-wide |
| `updateSwitchPort` | Update switch port config (profile, PoE, speed, STP) |
| `updateClient` | Update client settings |
| `setSwitchNetworks` | Set switch VLAN trunking configuration |
| `createRoute` | Create a static route (internal web UI API only) |
| `updateRoute` | Update a static route by ID (internal web UI API only) |
| `deleteRoute` | Delete a static route by ID (internal web UI API only) |
| `createPortForward` | Create a port forwarding rule (internal web UI API only) |
| `updatePortForward` | Update a port forwarding rule by ID (internal web UI API only) |
| `deletePortForward` | Delete a port forwarding rule by ID (internal web UI API only) |
| `updateWanPortSetting` | Update a gateway WAN port's IPv4/IPv6/MAC connection settings (e.g. DHCP client `unicastDhcp`) |

### Switch Port Tools

| Tool | Description |
|---|---|
| `setSwitchPortProfile` | Assign a LAN profile to a single port |
| `setSwitchPortPoe` | Enable/disable PoE on a single port |
| `setSwitchPortName` | Set name on a single port |
| `setSwitchPortStatus` | Enable/disable a single port |
| `setSwitchPortProfileOverride` | Enable/disable profile override on a single port |
| `batchSetSwitchPortProfile` | Batch profile override on multiple ports |
| `batchSetSwitchPortPoe` | Batch PoE on multiple ports |
| `batchSetSwitchPortStatus` | Batch enable/disable multiple ports |
| `batchSetSwitchPortName` | Batch set names on multiple ports |
| `startCableTest` | Start cable test on a switch |

### Action Tools

| Tool | Description |
|---|---|
| `rebootDevice` | Reboot a device |
| `adoptDevice` | Adopt a device |
| `blockClient` | Block a client |
| `unblockClient` | Unblock a client |
| `reconnectClient` | Reconnect a client |
| `setDeviceLed` | Set device LED setting |
| `setLogNotifications` | Turn alert/event log notification types on or off for a site; dry run supported, returns a before/after diff (live config write) |
| `setApRadio` | Change one AP radio band: enable, channel index, width, tx power. Reads back and verifies, fails if the controller does not apply it; dry run supported (live config write, can drop clients on that band) |
| `startFirmwareUpgrade` | Start firmware upgrade |
| `setGatewayWanConnect` | Connect/disconnect gateway WAN port |

### Generic

| Tool | Description |
|---|---|
| `genericApiCall` | Invoke any Omada OpenAPI endpoint directly |

### Meta

| Tool | Description |
|---|---|
| `getServerInfo` | Report the package version, git commit, and build time this server process was actually built from |

## Development

Requires Node 24 (see `.nvmrc`, use `nvm use`) and [Yarn 4](https://yarnpkg.com/) via Corepack (`corepack enable`).

```bash
yarn install
yarn dev          # Live reload via tsx
yarn build        # Compile TypeScript
yarn check        # Lint + type check
yarn start        # Run compiled server (stdio)
```

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

## Credits

Originally forked from [jmtvms/tplink-omada-mcp](https://github.com/jmtvms/tplink-omada-mcp). This project has since diverged significantly (full CRUD operations, switch port management, batch operations, cable testing, and more) and is now maintained independently rather than as an active fork.

## License

[MIT](LICENSE)
