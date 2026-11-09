# Per-AP SSID overrides

`getApSsidOverrides` reads one AP's SSIDs and, when internal web credentials are configured, its configured override state and inherited VLAN configuration. Password values are always redacted. Select the returned numeric `ssidEntryId`; it is distinct from the site-wide SSID ID and the displayed SSID name.

## Inherited VLANs

Legacy `vlanEnable`, `vlanId` and `vlanPoolIds` fields describe the controller's AP override surface, identified by `vlanFieldsScope:"ap_override"`. A false override flag does not establish an untagged SSID. Each entry now has `vlan.override`, `vlan.inherited` and `vlan.effective`:

```json
{
    "vlanEnable": false,
    "vlan": {
        "scope": "configured_ssid_tagging",
        "override": { "status": "known", "enabled": false },
        "inherited": { "status": "resolved", "mode": "explicit_vlan", "vlanId": 20 },
        "effective": { "status": "resolved", "mode": "explicit_vlan", "vlanId": 20, "source": "wlan_ssid" }
    }
}
```

The resolver reads at most 256 global SSIDs from the WLAN identified by internal AP configuration and joins by stable SSID ID, never by displayed name. An active AP VLAN override takes precedence. `inheritedVlanSource` identifies whether parent collection succeeded. Missing parent settings, unknown AP flags, ambiguous IDs, invalid values and unqualified advanced VLAN contracts remain `unknown`; a parent-read failure does not erase usable AP evidence.

When the parent explicitly disables custom VLAN tagging, `mode:"default_network"` is reported without guessing VLAN 1 or another numeric ID. A controller-native pool string is retained; an exact duplicate of the scalar VLAN ID is omitted. This resolves configured SSID tagging, not dynamic per-client/RADIUS VLAN assignment, packet delivery or firewall isolation. Reads are not atomic. Legacy field values and update behavior remain unchanged, and update previews/writes do not perform parent collection.

`updateApSsidOverride` applies a partial patch to exactly one entry. It defaults to a preview:

```json
{
    "apMac": "AA-BB-CC-DD-EE-FF",
    "ssidEntryId": 123,
    "settings": { "ssidEnable": false },
    "dryRun": true
}
```

Set `dryRun:false` explicitly to apply. Changing a broadcast, name, password or VLAN can disconnect clients on that SSID/AP. Site-wide SSID settings and other APs are not targets of this workflow.

## Typed settings

| Field                  | Contract                                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ssidEnable`           | Enable or disable this SSID on the selected AP.                                                                                                          |
| `overrideSsidEnable`   | Enable or disable the AP-specific name/password override.                                                                                                |
| `overrideSsidName`     | Nonempty SSID name, at most 32 UTF-8 bytes; requires an enabled name/password override.                                                                  |
| `overrideSsidPassword` | 8–63 printable ASCII characters; required to preserve/apply an active WPA-Personal override when the current password is hidden. Never echoed in output. |
| `overrideVlanEnable`   | Enable or disable this entry's VLAN override.                                                                                                            |
| `vlanId`               | Integer 1–4094; requires an enabled VLAN override.                                                                                                       |
| `vlanPoolIds`          | Existing controller VLAN-pool identifiers in the controller's string representation; requires an enabled VLAN override.                                  |

An active VLAN override requires a valid VLAN ID or pool identifiers. An active name/password override requires a name and, for personal security, a usable password. Enterprise/PPSK authentication remains inherited; this tool does not modify RADIUS or PPSK profiles. Unknown settings and empty patches are rejected.

## Preservation and evidence

The documented Open API v2 GET returns effective settings but can omit the override flags required by PATCH. The workflow reads the existing web API AP-detail endpoint for those flags, verifies matching SSID IDs/security, and requires affirmative `ssidConfigurable` evidence. It never substitutes guessed false flags. Without usable web evidence, effective reads remain available and updates fail before mutation.

Updates preserve the other entries' enablement and active name/password/VLAN overrides and submit the complete documented v2 list once. Inactive inherited name/password/VLAN values are not promoted into overrides. An unreadable active sibling password blocks the write; it is never replaced with a mask or blank value. Existing schedules, radio settings and site-wide SSID configuration are outside this endpoint.

A second snapshot rejects preflight drift. Read-back checks all active configured override entries and the AP/WLAN group identity, including unchanged siblings. Verified no-ops send no write. Lost acknowledgments are reconciled with bounded reads without replaying PATCH. `written:"unknown"` remains unknown even when read-back verifies the desired configuration. An uncertain or unverified result requires inspection before another change.

Verification covers configured AP overrides, not live broadcasting, connectivity or performance. No atomic compare-and-swap contract is available, so a race after preflight remains possible. Per-controller web API compatibility is established by live validation rather than inferred from the public schema.

Both tools belong to `wireless`; the global read-only profile excludes updates and update previews. Discovered v1/v2 override writes direct callers to the dedicated update workflow; discovery previews remain available.

## Validation

The workflow is covered by unit and MCP contract tests for typed inputs, full-list preservation, redaction, preflight drift, lost acknowledgments, controller rejection and scoped tool profiles. A live controller 6.3.0.45 test uses an owned, secured hidden SSID to exercise preview, AP-specific enablement, name/password and VLAN overrides, inheritance restoration, no-op detection and cleanup. Other APs retain their enablement, and all existing active overrides are compared before and after. VLAN-pool identifiers have fixture-based coverage; the live test does not create a pool.

The controller rejects the default LAN VLAN ID as an SSID override. It can echo a scalar VLAN ID in `vlanPoolIds`; verification accepts only that exact redundant representation and still rejects changed pool membership.
