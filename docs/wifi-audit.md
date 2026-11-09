# Wi-Fi audit workflow

`diagnoseWifi` combines site Wi-Fi dashboard evidence, AP radio configuration/metrics and saved RF results. It is read-only: no scans, optimization, or configuration changes are started.

```json
{
    "siteId": "your-site-id",
    "maxAps": 10
}
```

The configured site is used if `siteId` is omitted. AP selection is deterministic by normalized MAC, with a default limit of 10 and maximum of 25. Inventory pagination is capped at 2,000 records and receives cancellation when the 30-second collection budget expires. Oversized or incomplete inventory fails explicitly. Other in-flight read methods can finish within their existing client timeouts; the audit starts no new method calls after its budget.

## Read the evidence

The report contains inventory scope, dashboard evidence, per-AP radio/RF sections, observations, a portable `snapshot`, and optional `comparison`.

- Missing, malformed and failed reads remain explicit; absence does not mean zero or healthy.
- Saved RF status and timestamps are checked across reported bands. The oldest reported timestamp drives the 24-hour freshness policy, while absent/future/invalid time evidence remains unknown or partial. A running scan is reported without starting another one.
- Radio collection time is distinct from telemetry measurement time. Retrieval does not prove source freshness.
- Channel index/width are controller codes; power and utilization retain stated units. Dashboard traffic and retry/drop values stay controller-native where units are not established.
- Observations link to collected evidence. Disabled radios may be intentional. No universal score, root cause or performance improvement is inferred.

`collectionComplete:false` can be normal when no RF scan has been saved. It describes evidence coverage, not network health or an MCP execution failure.

## Save and compare a baseline

Save the returned `snapshot` in your client or local files. To compare, pass that exact object as `baseline` to a later call using the same site and `maxAps`:

```text
first = diagnoseWifi({siteId, maxAps: 10})
later = diagnoseWifi({siteId, maxAps: 10, baseline: first.snapshot})
```

The server does not write baseline files. Inputs are bounded and schema-validated. Comparison requires matching controller/site, AP inventory fingerprint, selected AP identities, collection limit, radio bands and summarized field availability. Both snapshots must be complete for the summarized radio configuration, and a future baseline is rejected as non-comparable.

The summarized fields are enablement, channel index, channel-width code, power level and power in dBm. `snapshot.complete` concerns those fields and inventory scope; it does not establish RF coverage, telemetry freshness or complete controller configuration. A comparable result lists configuration changes only. No changes means those summarized fields matched, not that performance improved or the network is healthy.

## Scoped access

The tool belongs to the `wireless` read category and is available in the global read-only profile. A composite audit uses internal inventory/dashboard dependencies while returning its defined Wi-Fi evidence. See [scoped tool profiles](scoped-tools.md) for the command-level permission model.

Controller 6.3.0.45 validation collected three APs twice and compared complete radio-configuration snapshots with no changes. Saved RF evidence was unavailable on all three APs, so the report correctly retained `collectionComplete:false` while allowing the configuration comparison.
