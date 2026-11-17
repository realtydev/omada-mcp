# Automatic API discovery

The existing tools remain available. Discovery tools let an assistant search the controller's API, inspect an operation, and execute a validated request without needing a separate MCP tool for every endpoint.

1. Call `searchApiOperations` with keywords, an optional category (`tag`), HTTP method, and a result limit from 1 to 50.
2. Pass a returned `operationId` to `describeApiOperation`. The description includes parameters, JSON schemas, controller documentation, and any execution limitations.
3. Pass that ID and the documented parameters/body to `executeApiOperation`.

For example, search with `{"query":"wireguard peers","method":"GET","limit":10}`. Use the returned operation ID rather than guessing an endpoint or operation name. Controller identifiers come from server configuration; a configured default site is filled in when needed. Site names are not automatically resolved to IDs.

Search recognizes common network vocabulary such as router/gateway, restart/reboot, Wi-Fi/WLAN/SSID, and access point/AP. Camel-case keywords are split into searchable words. Exact operation IDs rank first; method, tag and read-only filters still apply. Search never substitutes an operation when executing it.

## Specification source

`OMADA_API_SPEC` accepts:

| Value            | Behavior                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| `auto` (default) | Try the controller's OpenAPI documentation, then use the packaged snapshot if unavailable or invalid. |
| `live`           | Require usable controller documentation; fail clearly instead of falling back.                        |
| `bundled`        | Use the packaged snapshot without fetching controller documentation.                                  |

Discovery loads lazily and shares one cached snapshot per client process. Call `refreshApiCatalog` after controller firmware/documentation changes; restart the server after changing discovery configuration. Every search, description, and execution identifies its `source` and `loadedAt`; fallback searches/descriptions also explain why the bundled snapshot was selected. The bundled snapshot currently indexes 2,450 operations. A listed operation does not establish that a particular controller/device implements it.

Documentation requests stay on the configured controller, retain TLS verification/private-CA configuration, refuse redirects, and are bounded in size and duration. External schema references are not fetched. Split documentation groups must load consistently; partial or conflicting groups trigger fallback in `auto` mode or failure in `live` mode. Descriptions disclose unresolved references and bounded expansion.

## Discovery diagnostics and refresh

`searchApiOperations` and `describeApiOperation` include `discoveryDiagnostics` for the snapshot they used. Each bounded attempt records a stage (`combined`, `configuration`, numbered `group`, or `default`), outcome and a safe reason such as `http_error` with numeric status, `timeout`, `tls_error`, `unexpected_content`, `invalid_document`, `unsafe_documentation_path` or `group_conflict`. Raw exceptions, controller URLs, group names, headers and response bodies are omitted. This evidence explains fallback; it does not establish hardware support.

Call `refreshApiCatalog` with `{}` to reload the configured source. The tool accepts no URL, credentials, source override or controller mutation. Its `current` snapshot reports source, load time, schema/API version when safe, a document SHA-256 hash and operation count. When a prior snapshot exists, `previous` and `changed` make a source/document change explicit. Inspect `status`: `refreshed` means a valid replacement loaded, while `failed` reports whether the existing cache was retained.

Concurrent refresh calls share one load. Calls already using the old catalogue finish on that snapshot; normal reads can keep using it during refresh. Successful refresh replaces the cache atomically. A failed live-only refresh leaves the prior valid catalogue available; an initial failure leaves no usable cache. In `auto` mode, a valid bundled fallback is an intentional replacement and is identified as `source:"bundled"`; `bundled` mode reloads the packaged snapshot without network requests. Refresh does not reload environment variables or silently change the configured source mode.

Read-only profiles can refresh documentation. Existing read-only/category enforcement still governs searching, describing and executing operations from the replacement snapshot. A refresh does not grant additional permissions or turn every API operation into a registered MCP tool.

Live Controller 6.3.0.45 returned HTTP 404 for all three configured documentation probe stages. The complete bundled snapshot therefore remains the usable source; a fresh refresh confirms the same document hash. This is distinct from invalid JSON, TLS or authentication errors and does not imply that new undocumented endpoint paths should be guessed.

## Execution and existing safeguards

JSON execution validates declared required parameters, schema types, enums, ranges and supported JSON Schema constraints. It rejects unknown parameters, unsafe path values, caller-supplied controller IDs, custom authentication headers, unsupported serialization and invalid schemas. OpenAPI 3.0 and 3.1 are supported, with JSON Schema 2020 validation for 3.1. Local references and standard composition, tuple and unevaluated-property constraints are validated; external/dynamic references, custom dialects/vocabularies and unsupported serialization fail explicitly. Vendor prose and unknown format names are not executable validation rules. See [file transfers](file-transfers.md) for multipart and binary operations.

For canonical v1 site operations, a small set of explicit requirements supplements incomplete vendor schemas before both previews and writes:

| Operation              | Additional checks                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DDNS create/update     | Exactly one supported interval; services 2/3 require the standard interval; service 5 may omit it.                                                        |
| LAN DNS create/update  | IP/CNAME records select at least one LAN network; forward records omit LAN selection. Supply the target required by the record type and bound custom TTL. |
| LAN profile update     | Supply `untagNetworkIds` explicitly; an empty array is valid.                                                                                             |
| Voucher group create   | Supply only the rate-limit source selected by its mode.                                                                                                   |
| AP power-saving update | Enabled triggers require their fields and documented bounds; schemas declaring mode also require a valid mode and standard-mode triggers.                 |

These rules do not interpret arbitrary vendor prose or change undocumented AP routes. AP mode is required only when the selected request schema declares it; legacy snapshots retain their trigger contract. The declared mode contract limits bands to 0–3 and permits time/band triggers only in standard mode (1). Existing dedicated SSID validation remains authoritative. One exact vendor ASCII credential pattern is translated from Java octal escapes to equivalent JSON Schema escapes; its character and length restrictions remain intact. Unsupported schemas still fail closed. Other versions, MSP and template operations keep their declared contracts.

GET executes normally. Writes default to a preview with `dryRun:true` and `written:false`; only an explicit `dryRun:false` sends a mutation. Previews do not claim that the controller will accept the request. Most actual writes report `verified:false`, meaning no automatic read-back verification was performed. Canonical v1 site LAN DNS and mDNS rule writes provide the verified workflows below. [Managed workflows](managed-workflows.md) also cover SSID/WLAN lifecycle, policy routes and controller-side backups. A successful response alone is not proof that hardware applied a setting. Errors preserve controller details and warn that a failed write may have applied; discovery does not replay uncertain writes.

### Verified LAN DNS configuration

The existing `executeApiOperation` tool provides verified `createLanDns`, `modifyLanDns` and `deleteLanDns` workflows through their canonical v1 site routes; no additional tool names are registered. Canonical `createMdns`, `modifyMdns` and `deleteMdns` add the equivalent guarded rule workflow with profile/network reference validation; see [mDNS management](mdns-management.md). The current catalogue must also declare the LAN DNS list operation. Actual execution requires both network read and write permission. Previews retain their no-HTTP behavior.

Actual execution collects a complete list, rejects conflicting names/domains and missing update targets, preserves omitted known writable fields (including reported custom TTL settings) on update, and rereads the list to refuse preflight drift. Unchanged updates and absent deletes return `written:false`, `verified:true` without a mutation. Newer writable fields outside the supported LAN DNS configuration fail explicitly rather than being discarded.

After one mutation, the workflow rereads up to three times. `verification.status` is `verified`, `mismatch` or `unknown`, with a resource ID and observed configuration when available. Verification checks requested and preserved known fields, unique created identity and the other reported entries. DNS-name case and selection-array order are normalized; absent fields are never treated as empty. Incomplete or malformed evidence cannot prove absence. Bare arrays and paginated grids are supported with a 1,000-record and ten-page limit per collection. These bounds limit requests, not total wall-clock duration; each controller request retains its configured timeout.

Configuration verification does not test name resolution. The qualified OC200/ER8411 returned NXDOMAIN for `.test` fixtures while equivalent `.lan` records resolved, and CNAME writes omitted custom TTL fields. See [DNS resolution checks and observed quirks](dns-rollback.md#resolution-checks-and-observed-dns-quirks) before relying on a rule for live traffic. These observations do not change accepted domain syntax or weaken read-back verification.

An explicit controller rejection still throws with its error identity. An unacknowledged mutation is sent only once and remains `written:"unknown"`, even if readback verifies the desired state. This separates observed configuration from proof that this particular request applied it. Inspect current state before retrying. Eligible acknowledged, verified changes may return caller-held receipts for explicit [DNS rollback](dns-rollback.md); uncertain results never do, and rollback is never automatic. Verification covers only the known reported LAN DNS fields, not undocumented controller fields. Concurrent changes after the final preflight read remain possible because conditional writes are not established.

Use the existing dedicated tools where they provide stronger workflows. Radio configuration, DHCP reservation, rate-limit profile, SSID basic configuration, switch-port setting and log-notification mutations can be previewed through discovery, but execution directs callers to their dedicated tools to preserve preflight checks, preservation, reconciliation and read-back verification.

`getControllerCapabilities` reads metadata and this same cached catalog, reporting documentation separately from observed support. See [controller capabilities](controller-capabilities.md) and [switch safety](switch-safety.md).

`MCP_TOOL_PROFILE=read-only` exposes all three discovery tools but limits search, describe and execution to GET operations. Writes, including write previews, are rejected independently in the execution layer. Read-only means no mutations; controller permissions still govern access to returned information. Credentials in tool/request logs and write-preview bodies are redacted; read results remain usable controller data. Controller/site restore operations additionally require explicit `recovery` permission, even in the full profile; an `all` fallback does not grant it.

Each execution returns one API page; discovery does not aggregate pages. Required pagination defaults to `page:1` and a schema-bounded `pageSize` of at most 100; supply documented page parameters to fetch later pages. Prefer the existing list tools when you want their fetch-all behavior. Request/response sizes and schema expansion are bounded.

## Reviewing a bundled specification update

Run `yarn api:refresh --source /path/to/controller-openapi.json` to compare an explicit controller or TP-Link document with the full bundled snapshot. An HTTPS source URL is also accepted; it must not contain credentials, query parameters or a fragment. Fetches refuse redirects and have a 10-second timeout and 16 MiB size limit.

The JSON report includes source identity, versions and hashes, added/removed HTTP method/path pairs, and changed operations, including changes to referenced request and response schemas. Reordering object keys produces no change; array order is preserved. `info.version` alone does not establish controller or hardware compatibility.

The command is report-only unless `--write` is supplied. Adoption atomically replaces `docs/openapi/00-all.json`, leaving split historical snapshots unchanged. Incomplete or external references appear as warnings; changed documents with those warnings require manual review before adoption. The previous 1,676-operation bundle contained a malformed vendor reference, so the refresh comparison reports `comparisonComplete:false` for that old side. The adopted source resolves its local references; future comparisons still disclose any unresolved references explicitly. Discovery continues to disclose unsupported operations independently. Exit 0 means comparison/adoption succeeded; exit 1 means invalid input or a fetch/write failure. Review schema changes and run the checks before shipping a refreshed snapshot.

### Bundled snapshot provenance

The 2026-11-16 refresh was downloaded directly from [TP-Link's public combined specification](https://use1-omada-northbound.tplinkcloud.com/v3/api-docs/00%20All), with TLS verification, no redirects, and a 16 MiB download limit. The downloaded bytes had SHA-256 `64eb0c610558a754bdb02b5573f71296f20d84a2ed55dd527f5e806c5847810a`. The adoption script stores the complete document with normalized formatting; this source-byte hash is not the packaged file's byte hash.

The document declares OpenAPI `3.0.1` and API `info.version:"v0.1"`; neither identifies the controller firmware version. The comparison found 811 added, 37 removed and 1,639 changed method/path contracts, producing 2,450 indexed operations. Removed or renamed contracts are not silently retained as aliases. Existing dedicated tools keep their explicit, hardware-qualified routes independently of this discovery snapshot. Review an operation's current description before reusing saved discovery parameters or bodies.

The refreshed catalog includes site incidents/health, switch and stack LLDP neighbors, and existing WIDS/rogue-AP reads. API v3 entries remain searchable documentation with an explicit unsupported reason: execution still accepts only configured controller/MSP Open API v1/v2 routes. New read-named POST operations remain mutations for policy purposes. Read-only profiles block them, and full-profile execution still requires an explicit write request. New aliases for DHCP user-list reservation creation, site-level SSID basic configuration and multi-port switch configuration are directed to the existing verified tool families. Generic configuration payloads do not bypass those families' preservation, disruption or verification checks. Gateway-integrated WLAN configuration and site-template configuration are distinct scopes; this release does not claim dedicated verified support for them. Stack port and LAG configuration mutations are previewable but actual execution is refused until stack unit/slot identity and read-back safeguards are implemented. This restriction covers single-port and batch configuration plus LAG modification/deletion in both documented API versions; it does not claim that standalone switch tools support stacks. Other generic writes still require explicit execution and report unverified outcomes.

This global specification advertises contracts; it does not establish local controller support, permission, firmware availability or measurement freshness. Category scopes, strict input/schema validation, transfer limits, dedicated-write protections and no-replay behavior continue to apply. An invalid vendor schema or regular expression is refused before I/O; constraints are not silently removed to make an operation executable. For example, the unchanged DHCP-reservation description pattern is not valid under the execution validator, while the dedicated DHCP workflow remains available.

## Validation

Run `yarn build`, then `yarn smoke:discovery` with controller credentials in `.env`/`.env.local`. The script installs a guard that permits controller reads and authentication only, exercises search/describe/execute, and checks that write attempts are rejected before reaching that guard. Output contains counts and status without network identifiers.

OC200 / Controller 6.3.0.45 validation used the bundled fallback because the standard documentation routes were unavailable. Discovered site, device, client, Wi-Fi summary and rate-limit profile reads passed. A separate guarded test created one unassigned profile with both limits disabled, verified it, deleted it and verified removal. Live specification loading, malformed/conflicting documents and unsafe references have controlled fixture coverage.

## MSP scope

When category scopes are configured, MSP operations require `msp:r`/`msp:rw` or the matching `all` fallback; customer-site categories do not implicitly grant cross-customer access.

Set `OMADA_MSP_ID` explicitly for `/openapi/v1/msp/{mspId}/...` operations. It is never inferred from or substituted with the controller ID, and callers cannot override it in tool inputs. `OMADA_OMADAC_ID` remains the controller/customer context used by existing tools. If OAuth credentials were issued for a different principal, `OMADA_AUTH_ID` overrides the identifier in token requests only; it does not change either route context. Use the principal and permissions issued with your integration. MSP access is fixture-tested because the available live controller is not an MSP account.

The canonical LAN DNS validator narrowly corrects three hardware-qualified vendor item limits that incorrectly duplicate array counts: DNS-server address length, IPv6-address length and alias-name length. Array-count limits remain unchanged, and IP/FQDN validation still applies. Different future constraints and unrelated operations retain their declared schema validation.
