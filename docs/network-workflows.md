# Diagnostics and verified network changes

## Traffic, RF and WAN evidence

- `getTrafficHistory` returns timestamped AP and switch traffic samples.
- `getWifiHistory` collects channel usage, interference and retry/drop histories. Supply `apMac` to include that AP's mesh evidence.
- `diagnoseWan` takes `gatewayMac` and combines current WAN status, ISP history and gateway health.

All three accept `siteId`, epoch-second `start`/`end` windows up to 24 hours, and `maxSamples` (default 144, maximum 1,000). The default window is one hour. Time-series limits are explicit; device and channel inventories are bounded separately. Results include capture times, the requested window, per-section status, missing evidence, truncation and `collectionComplete`. These tools do not start RF scans, speed tests or configuration changes.

Values retain controller-defined units and timestamps. Traffic fields such as `rxData` and Controller 6.3's `dxData` retain their actual names with alias metadata. Missing utilization on a listed channel is partial evidence, not zero utilization. Snapshots are distinguished from time-window history; the tools do not invent health scores or interval/cumulative traffic totals. Existing `getGatewayWanSpeedTestResults` remains available for saved speed-test results.

## Verified rate-limit profile updates

`updateRateLimitProfile` accepts a `profileId`, optional `siteId`, and partial settings: `name`, `upLimitEnable`, `upLimit`, `downLimitEnable`, `downLimit`. Limits are in kbps. Enabled limits must be 1–10,485,760; omitted settings and disabled-limit representations are preserved.

The tool reads existing settings, validates the complete desired configuration and defaults to `dryRun:true`. Set `dryRun:false` explicitly to update. Unchanged settings produce a verified no-op. Writes are followed by bounded read-back verification; uncertain mutations are reconciled without replaying the write.

Only verified changes issue a `rollbackReceipt`. Keep that JSON receipt if you want to undo the change later. `rollbackNetworkChange` accepts the receipt and defaults to a preview; set `dryRun:false` to restore and verify the original settings. A receipt can be used by a fresh server process because it contains the necessary data rather than referencing an in-memory journal.

Receipts are versioned and scoped to the controller, site and profile. They are validated data, not authorization tokens. Controller credentials still authorize every operation. Rollback checks that current settings match the applied snapshot and refuses intervening edits; an already-restored profile is a safe no-op. The controller offers no atomic compare-and-swap, so operators should avoid simultaneous changes to the same profile. Unverified outcomes return no receipt and require inspection.

## Extended rollback receipts

`rollbackNetworkChange` also accepts version-1 receipts from verified DHCP reservation, AP radio and eligible SSID basic changes. The original rate-limit receipt format remains valid. Existing write tools retain their current execution defaults; rollback itself always defaults to a preview.

- **DHCP reservations:** verified create/update/delete operations can issue receipts containing the canonical writable configuration and stable controller row ID. Undoing a create removes that exact reservation; undoing a delete recreates its prior configuration; undoing an update restores the prior writable fields. A same-MAC replacement or intervening edit is refused. Updates that add a previously absent optional field do not issue receipts because PATCH cannot reliably remove that field. Recreated rows receive a new controller ID; a repeated rollback is a no-op when the original configuration is already present.
- **AP radios:** verified changes can issue receipts containing the documented writable configuration across observed bands. Rollback refuses configuration drift, restores only the recorded target band and checks that a manual channel still maps to the original available frequency. Auto-channel measurement frequency is not treated as fixed configuration. Missing required configuration, changed field presence or unexpected sibling changes prevent receipt issuance. Applying a radio rollback can disconnect clients, just like applying the original change.
- **SSID basic settings:** receipts are deliberately limited to complete, secret-free open (`security:0`) and enterprise (`security:2`) configurations with unchanged security mode and field presence. Receipts never contain personal/pre-shared passwords, password hashes or PPSK data. PSK/PPSK changes and incomplete or masked evidence continue to use the existing preserving update workflow but return `rollbackUnavailable` instead of pretending they are reversible. This does not cover SSID enablement, scheduling or other sub-resources.

Each restoration rechecks the controller/site/resource and applied configuration, then uses one mutation and bounded read-back verification. Authentication retry is disabled for these mutations; a lost acknowledgement is reconciled with reads and never replayed. No receipt is issued for an unverified result. Scope permissions follow the receipt resource (`clients` for rate limits, `network` for DHCP, `wireless` for SSID/radio), even though the same rollback tool handles all four resources. The compare-before-write check is not atomic: avoid concurrent edits to the same resource.

Log-notification workflows retain their existing behavior. Discovery still directs actual protected writes to the dedicated verified tools.

## Validation

Live OC200 / Controller 6.3.0.45 validation covers traffic history, RF and WAN evidence. An unassigned test profile was changed, read back, checked for drift refusal, restored using a receipt in a new client, and deleted with removal verified. No test profile was assigned to a client or device. MSP and OpenAPI 3.1 are covered by controlled protocol/schema fixtures; the available controller is not an MSP account or a 3.1 specification source.

Extended rollback validation used a disabled, unassigned DHCP fixture: create/update/delete receipts, a fresh-client preview and restoration, drift refusal, same-MAC replacement refusal, and repeat no-ops all passed. Cleanup verified the original seven reservations were unchanged. AP radio and secret-free SSID mutation/rollback paths are protocol-fixture tested; no active AP or SSID settings were changed for validation.
