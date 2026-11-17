# Write defaults, compact mode and managed workflows

## Write migration

Every mutating MCP tool now defaults to a preview in both catalog modes. Supply `dryRun:false` explicitly to apply. Existing tool names remain available in standard mode. Update automation that previously relied on omitted `dryRun` applying a change.

Tools with native previews retain their existing preflight and verification behavior. Older actions without native previews return a redacted, schema-only preview without calling the controller. This preview establishes valid MCP arguments, not controller acceptance or hardware support. Applying these older actions retains their original response format and does not add read-back verification. The low-level TypeScript client method defaults are unchanged; this migration is at the MCP registration boundary. GET calls still execute normally.

## Compact catalog

Set `MCP_CATALOG_MODE=compact` and restart the server. The default is `standard`.

| Tool                    | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `searchTools`           | Search enabled tool names and descriptions with a bounded result count. |
| `describeTool`          | Retrieve the selected tool's input schema and annotations.              |
| `getServerCapabilities` | Report catalog mode, enabled tool count and write exposure.             |
| `callTool`              | Validate arguments and invoke the existing handler by exact name.       |

For example, call `describeTool` with `{"name":"setApRadio"}`, then `callTool` with `{"name":"setApRadio","arguments":{"apMac":"AA-BB-CC-DD-EE-FF","band":"5g","channelWidth":5}}` to preview. Applying requires `dryRun:false` inside `arguments`.

Category restrictions and read-only profiles apply before search results are built and again during invocation. Compact mode changes catalog exposure, not authorization or controller capability. API operation IDs remain separate from tool names: invoke `searchApiOperations`, `describeApiOperation` and `executeApiOperation` through `callTool` to use discovery. Full controller responses are not shortened by this mode.

## SSID, WLAN group and policy-route management

Use the existing discovery tools to inspect and execute these canonical v1 site operations. No additional per-operation MCP wrappers are registered.

| Resource     | Operation IDs                                                            | Required scope for execution |
| ------------ | ------------------------------------------------------------------------ | ---------------------------- |
| WLAN group   | `createWlanGroup`, `updateWlanGroup`, `deleteWlanGroup`                  | `wireless:rw`                |
| SSID         | `createSsid`, `deleteSsid`; existing `updateSsid` tool for basic updates | `wireless:rw`                |
| Policy route | `createPolicyRouting`, `modifyPolicyRouting`, `deletePolicyRouting`      | `network:rw`                 |

Discovery previews validate the declared schema and supplemental conditions without HTTP. Execution reads a complete inventory, rejects conflicting names and missing update targets, preserves omitted known writable update fields, checks drift, sends one mutation and reads configuration back up to three times. Unchanged updates and absent deletions are no-ops. Inventories are bounded to 1,000 records and ten pages; incomplete or malformed data stops the workflow. Raw generic lifecycle and policy-route writes are directed to these workflows.

SSID creation reuses existing security validation and reads the resulting SSID detail. Secret fields are never considered independently verified: `notVerifiedFields` identifies them and the overall result remains unverified. WLAN creation supports `clone:false`; copying a group's SSIDs is unsupported. WLAN deletion requires an explicitly non-primary, empty group. Delete its SSIDs individually first.

Policy routes require nonempty, unique protocol and source/destination lists. Source/destination references must exist in the appropriate LAN network, IP-group or IP-port-group inventory. Select an explicit interface type and either an interface ID or a nonempty multi-interface selection. Readback confirms reported configuration, not WAN/VPN reachability, traffic forwarding or device convergence.

`written:true` means the controller acknowledged the request. `written:"unknown"` means acknowledgement was lost, even if the desired state is subsequently observed. `verification.status` is `verified`, `mismatch` or `unknown`; missing fields never count as success. Do not blindly retry uncertain writes. No automatic rollback is performed. Concurrent changes after the last preflight read remain possible because conditional writes are not established. Verification covers known writable fields reported by the controller, not undocumented settings.

## Backups and recovery

`backupSelfServer` and `backupSitesSelfServer` use the existing `executeApiOperation` tool and require `maintenance:rw`. Multi-site backups accept 1–20 distinct site IDs. Inspect the operation schema, preview, then explicitly execute with `dryRun:false`.

The workflow checks status and file inventory for every target, refuses an already-running backup, submits once, and polls status/files up to three times. Status zero alone is insufficient because it also means idle. Verification requires exactly one new or changed file per target and finished status. Longer jobs return an unconfirmed result; use discovery's backup status and file-list reads to inspect progress before retrying. These limits bound request count, not total duration; individual requests retain their configured timeout.

Backups remain on the controller. Existing [file transfers](file-transfers.md) support separately requested downloads. Observing a file does not verify archive contents or restorability. File-server/cloud backup operations retain their existing discovery behavior and unverified outcomes.

Controller/site restore operations now require an explicit `recovery:w` or `recovery:rw` scope; `full`, `all:rw` and `maintenance:rw` alone do not grant it. For example, `MCP_TOOL_CATEGORIES=all:r,maintenance:rw,recovery:rw` permits backup and recovery with reads. Global read-only still blocks restoration. Restore remains an explicit, preview-first discovery operation with an unverified outcome, not a tested disaster-recovery procedure.

These additions have mocked controller and MCP protocol coverage. Live creation, deletion, routing, backup and restore behavior still require controller-specific qualification.

## Client AP locks

`setClientApLock` uses the existing client-action implementation and requires `clients:w`. Like other dedicated write commands, its client-detail and eligible-AP reads are dependencies of that command. To inspect eligible APs separately, discover `getAllApBriefInfosBySite` (`wireless:r`); existing `getClient`/client-detail discovery returns reported lock configuration.

Preview with `{"clientMac":"AA-BB-CC-DD-EE-FF","enable":true,"aps":["AA-BB-CC-DD-EE-01"]}`. Inspect `before` and `desired`, then repeat with `dryRun:false` to apply. Unlock with `enable:false` and an empty or omitted `aps` list. MACs accept compact, colon or hyphen notation and are normalized to the controller's uppercase hyphen format. Enabled lists must be unique and contain 1–64 APs (a local request bound, not a promised device limit).

Enabling a changed lock requires a wireless, unblocked client and selected APs that are present, connected and explicitly report `supportLockToAp:true`. Missing or contradictory evidence stops the operation. Unlocking does not require the previous AP to remain online. Unchanged settings are no-ops. Execution rereads client state to reject drift, sends one POST without retry, then verifies reported lock settings with bounded reads. Lost acknowledgement remains `written:"unknown"`; missing readback is `unknown`, not success.

Lock changes can disconnect the client and limit roaming. Verified configuration does not prove association, radio coverage or reachability. AP availability can change after preflight. Single-client and batch discovery/raw AP-lock writes are directed to the guarded setter. Live AP locking has not been exercised.

## PoE scheduling

Use `searchApiOperations` and `describeApiOperation` to inspect `getPoeScheduleList`, `createPoeSchedule`, `modifyPoeSchedule` and `deletePoeSchedule`. Writes reuse `executeApiOperation` and its existing managed-resource executor; no new tool wrappers are registered. Schedules use `switching` scope. Create/update execution requires `switching:rw,network:r`, because the referenced time-range inventory uses network read permission. Deletion and disable-only updates need `switching:rw` only.

First inspect `getTimeRangeList` and `getPoePortsList`. Select an existing time-range `profileId` and the exact device MACs and `poePort.poePortIds` reported by the controller. Existing discovery operations can manage time-range profiles separately; this workflow does not create or edit them implicitly.

Example `executeApiOperation` preview:

```json
{
    "operationId": "createPoeSchedule",
    "params": { "siteId": "your-site-id" },
    "body": {
        "name": "Office power",
        "status": false,
        "turnOnTime": "existing-time-range-id",
        "poePortsMap": { "AA-BB-CC-DD-EE-01": [1, 2] }
    }
}
```

`status:false` creates a disabled schedule. Set it to `true` to enable scheduling, and explicitly set `dryRun:false` to submit a reviewed request. Updating uses the same required configuration with `params.poeScheduleId`; omitting a device/port from the map removes that assignment. Delete supplies `poeScheduleId` without a body. GET listing requires `page` and `pageSize`.

Previews validate schema, site consistency, nonempty time-range IDs and bounded unique device/port selections without HTTP. Execution verifies the time-range reference and explicit PoE capability for every selected port, refuses cross-site or ambiguous evidence, checks the complete schedule inventory for duplicate names and drift, and sends one mutation. It conservatively refuses assigning a port to two enabled schedules, even when their time windows appear disjoint. Disabled schedules may share ports. No-op updates and already-absent deletes do not write; deletion and disable-only updates can recover schedules whose device/profile references are no longer available. A disable-only update changes only `status` to `false`; it retains drift detection and readback without checking those references. Changing targets, time range or other fields still requires reference validation.

Readback compares the entire target map, normalizing MAC notation and port ordering. Unexpected device assignments, missing fields or changed sibling schedules cannot yield verified success. Inventories and target selections are bounded to 1,000 records/ports; schedules use the existing ten-page collection limit. Known optional writable fields are preserved; execution metadata such as `nextExecute` is not written back. Raw or unsupported-version schedule mutations cannot bypass this workflow.

PoE schedule changes can interrupt power to attached APs, phones and cameras. The controller's time-range profile, site timezone and DST settings determine execution; the MCP server does not convert local times or run its own timer. Verification proves reported configuration only, not that power switched at the scheduled time. Concurrent edits or capability changes after preflight remain possible. Live scheduling has not been tested.

## WireGuard interfaces and peers

WireGuard configuration reuses `executeApiOperation` in standard and compact mode. Use `security:rw` for guarded writes and their inventory reads. Discover and describe these operations before submitting a preview:

| Resource  | Read            | Create            | Update            | Delete            |
| --------- | --------------- | ----------------- | ----------------- | ----------------- |
| Interface | `listWireguard` | `createWireguard` | `modifyWireguard` | `deleteWireguard` |
| Peer      | `listPeer`      | `createPeer`      | `modifyPeer`      | `deletePeer`      |

These canonical v1 endpoints are **deprecated in the bundled controller specification** in favor of site-to-site VPN APIs. This workflow supports controllers that still expose them; it does not translate between VPN models or promise support on newer firmware. For nondeprecated APIs, use the [v2 site-to-site workflows](#site-to-site-vpns-v2) below.

Previews validate the schema without HTTP; set `dryRun:false` to apply. Updates and deletes use `params.id`. Supply the complete required configuration from `describeApiOperation` for create/update. Interface configuration includes `name`, `status`, `mtu` (576–1440), `listenPort` (1–65535), `privateKey` and IPv4 `localIp`. Peer configuration includes `name`, `status`, `interfaceId`, `publicKey`, a nonempty `allowAddress` CIDR list and `keepAlive` (0–65535 seconds). Use `status:false` to disable an interface or peer.

Additionally, **supply `presharedKey` explicitly on every peer create/update**: a valid 32-byte base64 key, or `""` to select no preshared key. Interface updates likewise require an explicit private key. Never submit a masked value from a controller response. Keys are redacted in previews, logs and submitted-secret error echoes. The workflow does not generate, export or persist keys; existing discovery reads still return controller data and must be treated as sensitive.

Optional `endPoint` accepts an IP address or hostname without scheme/port. Supply `endPointPort` with a nonempty endpoint. Hostnames require the peer inventory to advertise `supportDomain:true`. Omit both for a roaming peer on creation. Updates preserve omitted known optional fields; explicitly set `endPoint:""` to remove an existing endpoint and its port. `allowAddress` replaces the complete list; readback ignores ordering but detects extra or missing entries. CIDR checks validate syntax and exact duplicates, not route overlap or canonical subnet equivalence.

Execution checks bounded, complete inventories, duplicate names, missing targets and drift, then sends one mutation without replay. Peers must reference an existing interface and cannot duplicate another peer's public key on that interface. Interface address/listen-port reuse is conservatively refused, including disabled interfaces. Delete peers explicitly before deleting their interface; missing peer reference evidence also blocks interface deletion. Peer deletion does not require its former interface to exist. An exact disable-only update also skips interface availability and domain capability checks, while retaining explicit key input, drift checks and readback. All fields except `status` must match reported configuration; masked keys cannot prove this condition. Other edits still require reference checks.

Readback verifies reported configuration and unchanged sibling records. Nonempty private/preshared keys are always listed in `notVerifiedFields` and keep overall verification `unknown`; clearing a preshared key requires an observed empty value. Lost acknowledgements remain `written:"unknown"` and must be inspected before retrying. No automatic rollback occurs. Changes can disrupt VPN connectivity, and concurrent edits after preflight remain possible. Verification does not prove a handshake, routing or reachability. Live WireGuard configuration has not been tested.

## Site-to-site VPNs (v2)

Prefer these nondeprecated APIs for new WireGuard and IPSec configuration. They reuse `executeApiOperation` and the existing managed-resource lifecycle in both catalog modes. No new tool wrappers or dependencies are added. Existing v1 WireGuard tools remain available for older controllers; nothing migrates or deletes their configuration automatically.

| Purpose                             | Operation IDs                              |
| ----------------------------------- | ------------------------------------------ |
| Inventory and detail                | `getGridVpnS2SV2`, `getVpnS2SDetailInfo`   |
| Manual WireGuard or IPSec           | `createS2SManualVpn`, `modifyS2SManualVpn` |
| Automatic WireGuard or IPSec        | `createS2SAutoVpn`, `modifyS2SAutoVpn`     |
| Delete a qualified site-to-site VPN | `deleteVpnV2`                              |

All mutations default to schema-only previews without HTTP. Set `dryRun:false` explicitly to apply; updates and deletion use `params.vpnId`. Read the current detail before editing. Supply the required configuration for the selected protocol on every create/update. The controller's `vpnType` selects IPSec (`2`) or WireGuard (`4`); `siteVpnType` identifies automatic (`0`) or manual (`1`) in responses, and is not a writable body field. Updates refuse protocol, manual/automatic mode or automatic remote-site changes; replace those configurations explicitly.

The bundled manual request schema incorrectly requires both protocols' fields at once. Description and execution apply the same narrow, protocol-conditional correction to that known schema shape, retaining its property constraints and the original snapshot. Supplemental validation rejects fields from the other protocol and validates bounds and selectors. This correction follows the bundled field descriptions; its behavior has not been qualified on live firmware.

- **Manual WireGuard:** supply `name`, `status`, `vpnType:4`, `mtu` (576–1440), `servicePort` (1–65535), IPv4 `tunnelIp`, explicit `privateKey` and the complete `peers` array. An empty array removes all peers. Each peer requires `name`, `status`, `serverPublicKey`, explicit `preSharedKey` (empty string selects no PSK), nonempty CIDR `remoteSubnet` and `keepAlive` (0–65535). Optional `remoteIp` and `servicePort` must appear together; omit both or use an empty `remoteIp` without a port for roaming. Optional `comment` is supported. Omitted peers are removed; nested peer settings are not silently merged from stored or masked records. Names and public keys must be unique within the VPN. Remove peers explicitly before deleting a manual WireGuard VPN.
- **Manual IPSec:** supply `name`, `status`, `vpnType:2`, unique nonempty `wans`, `remoteIp` (empty is permitted by the vendor contract), nonempty CIDR `remoteSubnet`, explicit unmasked `preSharedKey`, a local network selection and `advancedSetting`. Advanced options retain the documented IKE/proposal/PFS enums and lifetime bounds; enabled DPD needs an interval, and name-based identities need names. No cryptographic defaults are chosen by the server. Optional `failoverSetting` requires an existing distinct backup WAN, explicit `failback`, and a 10–3600 second `failbackTime` when enabled. Omitted known advanced/failover fields are preserved during updates.
- **Automatic provisioning:** supply `name`, `status`, `vpnType` (`2` or `4`) and `remoteSite`. Both sites must exist and differ. The workflow checks VPN inventories and advertised protocol support on both sites and refuses conflicting automatic connections. One controller mutation requests provisioning; it does not separately configure the remote site or roll back either site.

Local networks use `networkType:0` with a nonempty `networkList` of existing LAN IDs, or `networkType:1` with nonempty `customNetwork` entries containing IPv4 `ip` and prefix `mask` (0–32). Supply only the selected list. Custom-network and optional WireGuard local-network configuration require advertised support. If provided, `existCustomNetwork` must match the selector. WireGuard peer hostnames, IPSec failover, advertised proposal choices and advertised subnet/peer limits are checked. Every selected IPSec port must explicitly be in WAN mode. CIDR checks validate syntax and exact duplicates, not overlap, subnet equivalence or routing safety.

Required scopes:

| Operation                               | Scope                   |
| --------------------------------------- | ----------------------- |
| Manual WireGuard without LAN references | `security:rw`           |
| Manual WireGuard with `networkList`     | `security:rw,network:r` |
| Manual IPSec create/update              | `security:rw,network:r` |
| Automatic create/update                 | `security:rw,system:r`  |
| Delete or exact disable-only update     | `security:rw`           |

Example automatic preview (replace the site IDs):

```json
{
    "operationId": "createS2SAutoVpn",
    "params": { "siteId": "local-site-id" },
    "body": {
        "name": "BranchLink",
        "status": false,
        "vpnType": 4,
        "remoteSite": "remote-site-id"
    }
}
```

Execution hydrates summary records through v2 detail reads, verifies identity/mode consistency, rejects duplicate names and drift, sends one mutation without retry, and polls configuration at most three times. The detail inventory is bounded to 100 VPNs per site; shared inventory reads retain their ten-page/1,000-record bound, and explicit peers are limited to 100 or the lower advertised device limit. No-op updates do not write. Disable-only updates skip availability/capability references while retaining drift checks and readback; all reported writable fields except `status` must match, so masked keys cannot establish this shortcut. Reordering peer/subnet selections does not cause false changes; missing or extra peers cannot establish success.

**Deletion compatibility:** the shared `deleteVpnV2` path is now limited to IPSec/WireGuard targets explicitly identified in the site-to-site inventory. Unknown or client-to-site targets are refused, including already-absent targets, instead of falling through to an unqualified delete. Manage client-to-site deletion through the controller interface until it has a separately qualified workflow. Raw and legacy site-to-site mutation aliases redirect to the canonical v2 operations. Existing v1 WireGuard interface/peer writes retain their original guarded compatibility path.

Previews/logs redact private and preshared keys, including nested peers; updates require explicit keys rather than reusing masked values. `notVerifiedFields` identifies every nonempty secret. Automatic create/update/delete also report `remoteSiteConfiguration` as unverified: observing the local configuration cannot prove remote provisioning or cleanup. These fields keep overall verification `unknown` even when all observable local fields match. `written:true` means acknowledgement, not tunnel success; lost replies remain `written:"unknown"` and are never replayed. Configuration verification does not prove handshakes, forwarding, remote cleanup or gateway convergence. Changes may disconnect VPN traffic, concurrent edits after preflight remain possible, and no live VPN mutations were tested.
