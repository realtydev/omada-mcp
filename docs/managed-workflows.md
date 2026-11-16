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
