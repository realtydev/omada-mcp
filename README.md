# Omada MCP Server

Full CRUD MCP server for TP-Link Omada SDN controllers. Exposes 60+ tools for reading, writing, and managing sites, devices, clients, networks, switch ports, firewalls, and more — all via the Model Context Protocol.

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
        "OMADA_AUTH_MODE": "oauth",
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
        "-e", "OMADA_AUTH_MODE=oauth",
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
| `OMADA_AUTH_MODE` | No | `oauth` | `oauth` for classic OpenAPI credentials, `web` for Fusion web-session auth |
| `OMADA_CLIENT_ID` | OAuth mode | - | OAuth client ID |
| `OMADA_CLIENT_SECRET` | OAuth mode | - | OAuth client secret |
| `OMADA_OMADAC_ID` | Yes | - | Controller ID (omadacId) |
| `OMADA_SITE_ID` | No | - | Default site ID |
| `OMADA_WEB_USERNAME` | Web mode | - | Omada web UI username |
| `OMADA_WEB_PASSWORD` | Web mode | - | Omada web UI password |
| `OMADA_STRICT_SSL` | No | `true` | SSL verification (`false` for self-signed) |
| `OMADA_TIMEOUT` | No | `30000` | Request timeout (ms) |

For Fusion gateways that do not expose Platform Integration OAuth credentials, set `OMADA_AUTH_MODE=web` and provide `OMADA_WEB_USERNAME` / `OMADA_WEB_PASSWORD`. The server logs in through `/{omadacId}/api/v2/login` and uses that web session for OpenAPI requests.

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
| `getClient` | Get details for a specific client |
| `getSwitchStackDetail` | Get switch stack configuration and status |
| `searchDevices` | Search devices globally across all sites |
| `listDevicesStats` | Device statistics with pagination and filtering |
| `listMostActiveClients` | Top clients sorted by traffic |
| `listClientsActivity` | Client activity time-series data |
| `listClientsPastConnections` | Historical client connections |
| `getThreatList` | Security threat list with filtering |
| `getInternetInfo` | Internet / WAN configuration |
| `getPortForwardingStatus` | Port forwarding rules (User/UPnP) |
| `getLanNetworkList` | LAN networks and VLAN settings |
| `getLanProfileList` | LAN profiles for switch ports |
| `getWlanGroupList` | WLAN groups |
| `getSsidList` | SSIDs in a WLAN group |
| `getSsidDetail` | Detailed SSID configuration |
| `getFirewallSetting` | Firewall rules and policies |
| `getSwitchPorts` | All ports for a switch (status, PoE, speed, STP) |
| `getFirmwareDetails` | Firmware info for a device |
| `listEvents` | Paginated site events |
| `listLogs` | Paginated site logs |
| `listFirewallAcls` | Firewall ACL rules |
| `listRoutes` | Static routes |
| `getSwitch` | Full switch info including portList array |
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
| `createFirewallAcl` | Create a firewall ACL rule |
| `deleteFirewallAcl` | Delete a firewall ACL rule |
| `updateSwitchPort` | Update switch port config (profile, PoE, speed, STP) |
| `updateClient` | Update client settings |
| `setSwitchNetworks` | Set switch VLAN trunking configuration |

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
| `startFirmwareUpgrade` | Start firmware upgrade |
| `setGatewayWanConnect` | Connect/disconnect gateway WAN port |

### Generic

| Tool | Description |
|---|---|
| `genericApiCall` | Invoke any Omada OpenAPI endpoint directly |

## Development

```bash
npm install
npm run dev          # Live reload via tsx
npm run build        # Compile TypeScript
npm run check        # Lint + type check
npm start            # Run compiled server (stdio)
```

### Docker

```bash
npm run docker:build   # Build image
npm run docker:run     # Run with .env file
```

## Credits

Forked from [jmtvms/tplink-omada-mcp](https://github.com/jmtvms/tplink-omada-mcp). Extended with full CRUD operations, switch port management, batch operations, and cable testing by [realtydev/omada-mcp](https://github.com/realtydev/omada-mcp).

## License

[MIT](LICENSE)
