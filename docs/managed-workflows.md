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

**Deletion compatibility:** `deleteVpnV2` now qualifies targets across the site-to-site, VPN-server and VPN-client inventories. It supports site-to-site IPSec/WireGuard and the WireGuard/OpenVPN client-to-site workflows below. Unknown, ambiguous or unsupported targets are refused, including already-absent targets. Raw and legacy mutation aliases redirect to the canonical v2 operations. Existing v1 WireGuard interface/peer writes retain their original guarded compatibility path.

Previews/logs redact private and preshared keys, including nested peers; updates require explicit keys rather than reusing masked values. `notVerifiedFields` identifies every nonempty secret. Automatic create/update/delete also report `remoteSiteConfiguration` as unverified: observing the local configuration cannot prove remote provisioning or cleanup. These fields keep overall verification `unknown` even when all observable local fields match. `written:true` means acknowledgement, not tunnel success; lost replies remain `written:"unknown"` and are never replayed. Configuration verification does not prove handshakes, forwarding, remote cleanup or gateway convergence. Changes may disconnect VPN traffic, concurrent edits after preflight remain possible, and no live VPN mutations were tested.

## Client-to-site VPNs (v2)

Guarded configuration supports **WireGuard and OpenVPN only**, on both the server and outbound-client sides. Use existing discovery tools; no additional MCP wrappers or dependencies are registered. L2TP, PPTP, client-to-site IPSec and SSL VPN configuration/deletion remain outside this workflow. Mutations on the client-to-site lifecycle routes are guarded, so unsupported protocols do not fall through to raw execution.

| Resource            | Read                                           | Create            | Update            | Delete        |
| ------------------- | ---------------------------------------------- | ----------------- | ----------------- | ------------- |
| VPN server          | `getGridVpnServerV2`, `getVpnServerDetailInfo` | `createVpnServer` | `modifyVpnServer` | `deleteVpnV2` |
| Outbound VPN client | `getGridVpnClientV2`, `getVpnClientDetailInfo` | `createVpnClient` | `modifyVpnClient` | `deleteVpnV2` |

Describe the operation and preview first; writes default to `dryRun:true` with no controller calls. Supply `dryRun:false` explicitly to apply. Updates/deletion use `params.vpnId`. Configuration requires `security:rw,network:r` for VPN inventories and WAN/LAN references. Site LDAP profile reads use `security:r`. Deletion and exact disable-only updates need `security:rw`; deletion must be able to read all three v2 VPN inventories.

As with the site-to-site schema, the bundled server/client schemas mix required fields from unrelated protocols. Description and execution use the same narrowly matched protocol-specific correction. Two exact malformed Java-style credential regexes are translated to their printable-ASCII alphabet with the original username/password length bounds. Other property constraints and changed live-schema patterns are retained. The bundled snapshot is unchanged. These compatibility corrections have mocked tests, not live firmware qualification.

All configurations require `name`, `status`, `vpnType` (`3` OpenVPN or `4` WireGuard), and unique nonempty `wans`. Every WAN must exist and explicitly report WAN mode. Optional local networks reuse the site-to-site `networkType`, `networkList` and `customNetwork` rules. Updates preserve omitted known writable fields, discard inactive fields when a selector explicitly changes, and refuse protocol or WireGuard file/manual-mode changes. Replace those configurations explicitly.

**Servers:** supply `servicePort` and an explicit address pool: `ipPoolType:0` with `ipPool:{ip,mask}` (IPv4, prefix 1–32), or `ipPoolType:1` with ordered IPv4 `ipPoolStart`/`ipPoolEnd`. Supply only the selected form. Range pools require advertised support. Optional `customServer:true` needs an IPv4/FQDN `customServerAddress` and advertised support. Optional `dns1`/`dns2` accept IPv4 or empty values.

- WireGuard servers require `mtu` (576–1440), `keepAlive` (0–65535), explicit `privateKey` and the complete `clients` array, including an explicit empty array when removing all clients. Each client needs a unique `name`, unique usable `interfaceIp` within the pool, explicit `privateKey`, explicit `preSharedKey` (empty string means none), and `allowedAddressStatus`. Supply a nonempty CIDR `allowedAddress` list only when that flag is true. Duplicate private keys are refused. Optional `dnsStatus` requires advertised support. Read-only child IDs/public keys are never copied into writes.
- OpenVPN servers require `serviceType` (`0` UDP, `1` TCP), `tunnelMode` (`0` split, `1` full) and explicit `accountAuth`. Split tunnels require a local network selection. With account authentication enabled, select `authMode:0` with an explicit `vpnUserList` (empty allowed), or `authMode:1` with an existing `ldapProfile`. Every selected local user must be an existing OpenVPN user. Disable account authentication with `accountAuth:false` and omit those fields. This pass supports local and ordinary LDAP authentication; RADIUS and Google LDAP provisioning are not added.

**Outbound clients:**

- Manual WireGuard (`vpnType:4,setup:1`) requires IPv4 `tunnelIp`, `remoteIp`, `servicePort`, `clientPort`, `mtu`, `keepAlive`, explicit `privateKey`, `serverPublicKey`, explicit `preSharedKey` (empty allowed), and nonempty CIDR `allowedServerAddress`. Optional DNS fields accept IPv4/empty strings. Hostname endpoints require advertised WireGuard domain support; the controller schema retains its own endpoint-format restrictions.
- Imported WireGuard (`vpnType:4,setup:0`) requires `vpnConfiguration:{id,fileName}` referencing an already uploaded `.conf` configuration. Do not mix manual key/endpoint fields into this mode.
- OpenVPN clients (`vpnType:3`) require an already uploaded `.ovpn` `vpnConfiguration` and explicit `openVpnMode`: `0` certificate-only, or `1` certificate plus account. Account mode requires explicit `clientUsername` and unmasked `clientPassword` on every update. Certificate-only requests omit credentials.

Uploads use the existing explicit [file-transfer workflow](file-transfers.md), including `uploadVpnCertificateFileV2`; configuration does not upload, generate, parse or persist key material automatically. A certificate/configuration ID and filename do not prove file contents, ownership, server authenticity or tunnel reachability. Imported client results always include `vpnConfiguration.contents` in `notVerifiedFields`.

Execution reuses complete bounded inventories, detail identity checks, duplicate-name refusal, configuration drift detection, one mutation without replay and bounded readback. It checks advertised WireGuard support and optional authentication/network capabilities, device limits and conflicts between server listeners sharing a WAN and transport. Client/address lists are compared as complete sets; extra or missing clients cannot establish success. Pool checks validate membership and reject subnet network/broadcast addresses for prefixes below /31; they do not model every gateway-reserved address or detect overlap with the rest of the network.

**Shared deletion:** `deleteVpnV2` reads all three inventories and requires exactly one qualified target. Duplicate IDs across families, missing inventories, absent targets and unsupported protocols stop before mutation. The same inventories are reread for drift and deletion readback. Each family is bounded to 100 detail records. WireGuard servers must have an explicitly empty `clients` list. OpenVPN servers must have no selected local users and no user records associated with the server; missing user-association evidence also blocks deletion. Detach users/clients explicitly first. The workflow does not delete user accounts, LDAP profiles or imported files for you. Site-to-site deletion keeps its existing safeguards.

Exact disable-only updates retain drift/readback checks while skipping capability and WAN/LAN/profile availability checks. Explicit secret inputs remain mandatory; masked responses cannot establish equality for this shortcut. Previews and logs redact nested secrets, and nonempty private/preshared keys and passwords remain listed in `notVerifiedFields`. `written:true` reports acknowledgement; secret or imported-content uncertainty keeps overall verification `unknown`. Lost acknowledgements are not replayed. Readback verifies reported configuration only, not authentication, handshakes, traffic forwarding or device convergence. Concurrent edits after preflight remain possible. No live VPN configuration or deletion was tested.
