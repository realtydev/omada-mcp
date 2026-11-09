# Switch-port changes

Single-port and batch tools read configured state, validate targets, preview changes, and verify the result after one mutation. Their default remains to apply; use `dryRun:true` for a preview.

For `setSwitchPortName`:

```json
{
    "switchMac": "AA-BB-CC-DD-EE-FF",
    "port": 3,
    "name": "Office AP",
    "dryRun": true
}
```

PoE, profile, profile-override and administrative-status tools retain their setting arguments and accept optional `dryRun` and `allowDisruption` flags. Batches accept 1–32 unique physical port numbers. Every target is validated before any write.

## Preflight

Configured fields come from `getSwitch`; telemetry supplies additional PoE/stack/MLAG evidence when available. Live link state is distinct from configured administrative status. Stored `poeMode` alone does not prove PoE support: the observed non-PoE SG3210X-M2 also returned that field.

PoE operations require affirmative port support evidence and enabled profile override, even if the stored mode already matches. Enable and verify override separately when appropriate. The workflow never toggles overrides or power automatically. A blocked preview returns `canApply:false`; applying with blockers fails before writing.

Explicit LAG/uplink/stack/MLAG evidence blocks potentially disruptive edits unless `allowDisruption:true` is supplied. Renaming is not treated as a disruptive configuration change. The status endpoint remains unavailable for a known LAG port. This flag records caller intent, not human approval, and cannot override unsupported operations or PoE prerequisites.

Unknown evidence stays unknown. Port names, model guesses and link state are not used to declare a port safe. Some controllers omit uplink information, and site telemetry can omit entire switches.

## Outcomes

Results contain `dryRun`, `written`, `acknowledged`, `canApply`, warnings, and per-port changes/risks/blockers/verification. Verification identifies mismatched requested fields and unexpected changes.

- Previews never send mutations. Blocked previews do not claim verification.
- Verified no-ops send no mutation.
- A mutation is submitted once, including batch requests. Authentication retries cannot replay it.
- A lost response reports `written:"unknown"` and reconciles state with bounded reads. Inspect each port before deciding what to do next.
- `verificationScope:"configured_port_fields"` does not establish delivered PoE power or live connectivity. Profile edits can intentionally change inherited settings; verification cannot prove every profile effect.

A second snapshot detects selected configuration/risk drift before apply. A race after that read remains possible because no conditional-write contract is established.

## Tool scope

Single-port tools: `setSwitchPortName`, `setSwitchPortProfile`, `setSwitchPortProfileOverride`, `setSwitchPortPoe`, and `setSwitchPortStatus`.

Batch tools: `batchSetSwitchPortName`, `batchSetSwitchPortPoe`, `batchSetSwitchPortStatus`, and `batchSetSwitchPortProfile`. The last controls **profile override**, not profile assignment, preserving its existing API contract.

`updateSwitchPort` supports one `profileId` or `poe` setting per call, using a documented narrow endpoint. Speed, duplex, STP, isolation and combined updates lack a verified generic PATCH contract and are rejected before requests.

Discovery previews remain available. Actual discovered writes to these setting endpoints direct callers to the dedicated workflows. The read-only profile excludes mutations, including write previews. Guarded hardware previews use a full-profile server with the transport read-only guard installed.

Controller 6.3.0.45 validation passed a two-port name preview and a PoE no-op preview that correctly remained blocked with override disabled. A subsequent guarded live test renamed one confirmed unused port, verified the change, restored its original name and verified the original configuration. The guard allowed exactly those two label writes. Power, link status, profile, VLAN and radio settings were not changed. Lost-acknowledgement and mismatch behavior have controlled fixture coverage.
