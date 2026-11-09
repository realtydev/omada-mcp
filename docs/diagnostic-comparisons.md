# Compare diagnostic evidence

`getTrafficHistory`, `getWifiHistory` and `diagnoseWan` return a bounded, portable `snapshot`. Save it in your client and pass it as `baseline` to a later call of the same tool. The server stores no journal or baseline files.

```text
first = diagnoseWan({gatewayMac, start, end, maxSamples: 144})
later = diagnoseWan({gatewayMac, start: nextStart, end: nextEnd, maxSamples: 144, baseline: first.snapshot})
```

Use equal-duration windows and matching selectors/sample limits. The result reports `comparable`, `partial` or `not_comparable`, the baseline capture age, excluded metrics, and at most 100 detailed changed observations. Capture times and measurement timestamps have distinct meanings. Current snapshot measurements have unknown source freshness; retrieving them does not establish that the controller measured them recently.

## What is compared

- Traffic: AP/switch MB values at matching offsets within their requested windows. Before/after observations are retained, but no arithmetic traffic deltas, interval totals, rates or reset semantics are inferred. Samples may represent cumulative counters.
- WAN: gateway/port latency in ms and packet loss in percent, plus timestamped site-wide ISP latency samples in ms. Percentage changes are expressed as percentage points. Site-wide ISP samples may concern ports on other gateways; they remain separately identified.
- RF: current channel utilization/interference percentages and channel AP/client counts, matched by band/channel or normalized AP identity. These are current observations, not window-history averages. Missing utilization remains missing and does not become zero.

ISP `totalRate`, WAN health-detail metrics, retry/drop rates and mesh fields retain ambiguous or undocumented units/aggregation semantics and are excluded from numerical comparisons. Raw evidence remains available in the parent sections. No diagnostic score, root cause or performance improvement is inferred from changes or unchanged values.

## Compatibility and bounds

Snapshots bind controller/site fingerprints, workflow, selected AP/gateway, observed inventory, source endpoints, query duration and requested sample limit. Reordered inventories/series normalize deterministically. Different scope or inventory, a later baseline window, future baseline capture/completion, or changed sources prevent comparison. Inventories with duplicate identities are ambiguous and cannot be compared.

Within a matching scope, unavailable metrics, unit/semantic changes, changed sample offsets, null-availability differences and all-null/empty samples are excluded explicitly. Other matching metrics can still be compared as partial evidence. Truncated collection/snapshot/change details remain partial. Negative sentinel values, percentages outside 0–100 and non-integer counts are excluded rather than treated as valid measurements. No missing data is interpolated, extrapolated or replaced with zero.

Baselines accept only the versioned, strict snapshot shape: at most 1,024 metrics, 10,000 points overall, 1,000 points per metric and 512 KiB serialized JSON. Generated snapshots bound their metric payload below that size and contain no credentials or raw controller error messages. Controller/site fingerprints support equality checks; they are not authorization or proof that a caller-held baseline is authentic. Controller permissions still govern current reads.

All workflows remain read-only. They do not start scans, speed tests, reconnects or configuration changes. Save a new baseline after intentional scope, firmware/API contract or sampling changes.

## Live validation

Guarded OC200 / Controller 6.3 validation compared paired reads of identical windows: traffic had four comparable metrics, Wi-Fi retained partial channel evidence with 30 comparable metrics, and WAN had nine comparable metrics. All reported zero changed observations during that check. The run performed 15 reads and one authentication with no mutations or blocked requests.
