# Diagnostics and verified network changes

## Traffic, RF and WAN evidence

- `getTrafficHistory` returns timestamped AP and switch traffic samples.
- `diagnoseWifi` collects channel usage, interference and retry/drop histories. Supply `apMac` to include that AP's mesh evidence.
- `diagnoseWan` takes `gatewayMac` and combines current WAN status, ISP history and gateway health.

All three accept `siteId`, epoch-second `start`/`end` windows up to 24 hours, and `maxSamples` (default 144, maximum 1,000). The default window is one hour. Time-series limits are explicit; device and channel inventories are bounded separately. Results include capture times, the requested window, per-section status, missing evidence, truncation and `collectionComplete`. These tools do not start RF scans, speed tests or configuration changes.

Values retain controller-defined units and timestamps. Traffic fields such as `rxData` and Controller 6.3's `dxData` retain their actual names with alias metadata. Missing utilization on a listed channel is partial evidence, not zero utilization. Snapshots are distinguished from time-window history; the tools do not invent health scores or interval/cumulative traffic totals. Existing `getGatewayWanSpeedTestResults` remains available for saved speed-test results.

## Verified rate-limit profile updates

`updateRateLimitProfile` accepts a `profileId`, optional `siteId`, and partial settings: `name`, `upLimitEnable`, `upLimit`, `downLimitEnable`, `downLimit`. Limits are in kbps. Enabled limits must be 1–10,485,760; omitted settings and disabled-limit representations are preserved.

The tool reads existing settings, validates the complete desired configuration and defaults to `dryRun:true`. Set `dryRun:false` explicitly to update. Unchanged settings produce a verified no-op. Writes are followed by bounded read-back verification; uncertain mutations are reconciled without replaying the write.

Only verified changes issue a `rollbackReceipt`. Keep that JSON receipt if you want to undo the change later. `rollbackNetworkChange` accepts the receipt and defaults to a preview; set `dryRun:false` to restore and verify the original settings. A receipt can be used by a fresh server process because it contains the necessary data rather than referencing an in-memory journal.

Receipts are versioned and scoped to the controller, site and profile. They are validated data, not authorization tokens. Controller credentials still authorize every operation. Rollback checks that current settings match the applied snapshot and refuses intervening edits; an already-restored profile is a safe no-op. The controller offers no atomic compare-and-swap, so operators should avoid simultaneous changes to the same profile. Unverified outcomes return no receipt and require inspection.

This rollback workflow currently supports rate-limit profiles only. Radio, DHCP, log-notification and SSID workflows retain their existing behavior. Discovery directs actual rate-profile updates to the dedicated verified tool.

## Validation

Live OC200 / Controller 6.3.0.45 validation covers traffic history, RF and WAN evidence. An unassigned test profile was changed, read back, checked for drift refusal, restored using a receipt in a new client, and deleted with removal verified. No test profile was assigned to a client or device. MSP and OpenAPI 3.1 are covered by controlled protocol/schema fixtures; the available controller is not an MSP account or a 3.1 specification source.
