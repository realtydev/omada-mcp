# WAN failover guard

An optional companion process that fixes a specific Omada multi-WAN failure: **Link Backup never fails over because the primary WAN still looks "online" while its modem hands out a private fallback lease.**

## The problem

Many cable modems, when their upstream service drops, keep Ethernet up and give the router a local management lease such as `192.168.100.10` via `192.168.100.1`. That address reaches the modem but not the Internet.

In controller-managed mode, Omada gateways (seen on ER7206 v1 firmware 1.4.x) can keep classifying that WAN as online. Link Backup only switches when Online Detection reports the primary as down, so traffic stays pinned to a dead link. Changing the shared Echo target does not help, and controller mode does not expose standalone mode's per-WAN Manual ping / DNS controls.

## What the guard does

Every `OMADA_WAN_GUARD_INTERVAL_MS` it reads the gateway's WAN status through the Open API (`getGatewayWanStatus`) and looks at the configured primary port:

| Observation | Action |
|---|---|
| Primary port has an address outside the fallback CIDRs | `healthy`: reset the counter |
| Address inside a fallback CIDR, fewer than `FAILURE_THRESHOLD` consecutive times | `observed_fallback`: wait |
| Threshold reached, `DRY_RUN=true` | `would_disconnect`: log only |
| Threshold reached | `disconnected`: software-disconnect **only** the primary port so Link Backup moves traffic to the backup WAN |
| Port already disconnected | `already_disconnected`: do nothing |
| Controller request fails | Log the error and leave WAN state unchanged |

Recovery is deliberately manual. This matches Omada's "Link Backup" recovery mode and avoids knocking traffic off the healthy backup just to probe a modem that may still be failing. Reconnect the primary with the `setGatewayWanConnect` tool or the controller UI once it's back.

## Configuration

Set these alongside the normal `OMADA_*` controller variables (see [`.env.example`](../.env.example)):

| Variable | Default | Description |
|---|---|---|
| `OMADA_WAN_GUARD_ENABLED` | `false` | Must be `true` for the guard to start |
| `OMADA_WAN_GUARD_DRY_RUN` | `true` | Log the action it would take without changing anything |
| `OMADA_WAN_GUARD_GATEWAY_MAC` | (required) | Gateway MAC, e.g. `AA-BB-CC-DD-EE-FF` |
| `OMADA_WAN_GUARD_PRIMARY_PORT` | `2` | Primary WAN port number (see `getGatewayWanStatus`) |
| `OMADA_WAN_GUARD_FALLBACK_CIDRS` | `192.168.100.0/24` | Comma-separated CIDRs that indicate a modem fallback lease |
| `OMADA_WAN_GUARD_INTERVAL_MS` | `5000` | Poll interval |
| `OMADA_WAN_GUARD_FAILURE_THRESHOLD` | `2` | Consecutive fallback observations before acting |
| `OMADA_TIMEOUT` | `5000` for the guard | Controller request timeout, so a hung request can't stall the loop |

## Running it

```bash
yarn build
OMADA_WAN_GUARD_ENABLED=true OMADA_WAN_GUARD_GATEWAY_MAC=AA-BB-CC-DD-EE-FF yarn wan-guard
```

Start in dry-run, reproduce the failure (disconnect the modem's **coax/upstream**, not the Ethernet between modem and gateway), and confirm you see `would_disconnect` before setting `OMADA_WAN_GUARD_DRY_RUN=false`.

### Docker Compose

The published image runs the MCP server by default. Override the command to run the guard instead:

```yaml
services:
  wan-guard:
    image: ghcr.io/realtydev/omada-mcp:latest # pin a version tag in production
    command: ["node", "dist/wanGuard.js"]
    env_file: ./guard.env
    restart: unless-stopped
    read_only: true
    security_opt:
      - no-new-privileges:true
    mem_limit: 256m
    logging:
      driver: local
      options:
        max-size: 10m
        max-file: "3"
```

## Where to host it

The guard has to reach the controller over the LAN during an ISP outage, so run it **on-site**:

- **Best:** an always-on, wired, UPS-backed Linux / NAS / Proxmox host you already run.
- **Dedicated:** a Raspberry Pi 4 (2 GB is plenty) on wired Ethernet and the same UPS as the network gear.
- **Avoid:** cloud functions or VMs, which need the broken WAN to reach your controller. Also avoid running on the OC200 itself (not a supported app host) and laptops that sleep.

Run exactly **one** instance. The failure counter lives in memory, and multiple replicas would race each other on WAN state.
