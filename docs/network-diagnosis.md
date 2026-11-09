# Combined network diagnosis

`diagnoseNetwork` collects one read-only evidence report from managed inventory, clients, Wi-Fi, WAN, switch ports, inherited SSID VLANs, topology, RF planning, events and alerts. It does not change configuration, scan RF, reconnect clients, test failover or compute a health score.

```json
{
    "hours": 24,
    "maxAps": 10,
    "weakRssiDbm": -75
}
```

`siteId` is optional. `hours` bounds the event/alert lookback (1–24 hours, default 24); WAN telemetry covers the last hour. `maxAps` is 1–20, default 10. `weakRssiDbm` is an explicit review threshold between −90 and −60 dBm, default −75; it is a policy, not a universal connectivity requirement.

## Evidence and observations

`sections` independently reports devices, clients, Wi-Fi, switch-port coverage, topology, filtered events, alerts, RF planning, per-gateway WAN evidence and per-AP VLAN evidence. A source failure does not erase other sections. Failures return safe status/reason metadata without raw controller error messages. Client fields and topology summaries are projected; SSID credentials and raw topology trees are excluded.

`summary` preserves unknown counts as null when inventory collection fails. Missing/negative controller client-health scores become null, not a bad score. Each observation has a stable code, severity, `basis`, evidence paths and supporting details. Weak-client observations can point to the read-only `diagnoseClient` workflow.

| Basis                 | Interpretation                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `controller_snapshot` | A controller-reported state or metric, possibly cached. It does not prove physical conditions at the client. |
| `candidate`           | A configuration/radio relationship worth reviewing; it is not a proven root cause.                           |
| `historical_event`    | A recorded incident or recovery in the requested window, not an automatic statement of current state.        |
| `evidence_gap`        | Missing, partial, stale, unqualified or truncated evidence limits the diagnosis.                             |

Rules cover weak wireless RSSI, devices outside a known connected state, overlapping qualified 5 GHz spectrum, wide 2.4 GHz operation, reported STP discarding, stale topology, historical switch loops/clears and radar events. They do not infer outages from missing metrics, calculate packet-loss percentages from lifetime counters or infer throughput from link/PHY rates.

The operating-channel parser accepts the controller's `157 / 5785MHz` format, checks channel/frequency agreement within the reported band, and distinguishes operating channels from configured auto/index values. Channel overlap uses standard 5 GHz 20/40/80 MHz blocks (36–64, 100–144 and 149–161) and the lower two 160 MHz blocks. Other channelizations, including 6 GHz overlap, are not inferred. Two APs sharing spectrum may be physically separated; no RF visibility or harmful contention is established. See [Cisco's channel-bonding explanation](https://blogs.cisco.com/networking/winning-back-the-weather-radio-channels-adds-capacity-to-5ghz-wi-fi-spectrum).

A historical loop is marked cleared only when a later returned clear identifies the same switch and physical-port label. Unknown or mismatched identities remain uncorrelated. Native unqualified port labels are not equated with stack unit/slot identities. Current STP discarding stays a separate observation even after a historical clear; it alone does not establish a loop. No matching recovery in a bounded window does not establish an active loop.

## Bounds and access

Inventory is capped at 1000 devices and 1000 clients; gateways at four; APs at `maxAps`; per-AP inherited VLAN reads at 256 entries. The port reader retains its own bounds; this report includes at most 512 port-detail rows. Each WAN source retains at most 72 historical samples. Events exclude the `OSG_` prefix to reduce DHCP noise and scan at most four 1000-row controller pages, returning at most 200 matches. Alerts return at most 200 records. Missing source counts do not establish a complete log window.

At most 100 prioritized observations are returned, with available counts and truncation flags. Truncated/invalid logs, clipped collections, missing RF evidence, stale topology and unknown operating channels keep `collectionComplete:false`. That flag describes evidence completeness, not network health; even a complete report with no observations is not a certification of fault absence.

Independent primary reads run concurrently; bounded per-gateway/AP reads follow inventory. Existing collector/request timeouts apply; there is no hard whole-report latency guarantee or atomic snapshot. Managed inventories can omit unmanaged or gateway-integrated ports. VLAN resolution covers configured SSID tagging, not dynamic client VLANs, packet delivery or firewall isolation.

The tool requires read permission in all six categories: `devices`, `clients`, `wireless`, `switching`, `network` and `monitoring`. It works in the global read-only profile or corresponding explicit read scopes. A restricted profile missing any category hides and denies the workflow, including direct facade calls. No extra controller permissions are implied.

Unit and MCP contract tests verify rule eligibility, recovery matching, source failures, output bounds, redaction, parser qualification and composed access. Live acceptance uses a real HTTP MCP connection with a transport guard that permits controller reads and exact authentication requests only. Findings are checked against their returned evidence paths; no network mutations are performed.
