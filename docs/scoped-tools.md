# Scoped tool profiles

Keep `MCP_TOOL_PROFILE=full` or `read-only` and optionally set `MCP_TOOL_CATEGORIES` to restrict capability groups:

```dotenv
MCP_TOOL_PROFILE=full
MCP_TOOL_CATEGORIES=all:r,wireless:rw
```

This example permits reads across known categories and writes only in `wireless`. The global `read-only` profile still blocks every mutation, including write previews, even if a category grants writes.

## Categories and syntax

| Category      | Public command families                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `msp`         | Explicit MSP account/customer/admin routes                               |
| `system`      | Site listing and controller/build information                            |
| `devices`     | Device inventory, adoption, reboot and locating                          |
| `clients`     | Client diagnostics/settings/actions and rate-limit profiles              |
| `wireless`    | AP radios, SSIDs, saved RF diagnostics and Wi-Fi audit                   |
| `switching`   | Switch ports, stacks, PoE, cable tests and LAN port profiles             |
| `network`     | WAN/LAN networks, DHCP, routes and forwarding                            |
| `security`    | Firewall, ACLs, IPS, wireless security diagnosis, threats and VPN status |
| `monitoring`  | Dashboards, topology, logs and composed client/log diagnostics           |
| `maintenance` | Firmware, backups and site LED controls                                  |
| `recovery`    | Controller/site restore operations; explicit permission required         |

Each entry uses `:r`, `:w`, or `:rw`. A specific category overrides the `all` fallback: `all:rw,security:r` denies security writes. Missing categories have no permission unless `all` supplies it. Unknown categories, duplicate entries, empty strings, missing permissions and malformed entries fail configuration validation.

Controller/site restoration always requires an explicit `recovery:w` or `recovery:rw` entry; neither an unset variable nor `all:rw` grants recovery. All other full/read-only behavior is preserved. Explicit `all:rw` is still scoped: unknown route families are denied, unlike the legacy unrestricted raw escape hatch.

## Enforcement

One policy governs tool registration and handler invocation, configured client methods, discovery search/describe/execute, and generic API calls. Per-server restrictions intersect configured client restrictions; one server cannot broaden a shared client's access or change another server's policy.

Discovery/status helpers, including `refreshApiCatalog`, remain usable, but discovered operations are filtered and authorized independently. Optional SSID evidence in `getControllerCapabilities` requires wireless read permission. A denied operation cannot be enabled through a preview, operation ID or raw path.

Generic calls require canonical relative paths and supported methods/versions. Absolute URLs, encoded traversal/separators, controller-prefix substitution and controller query overrides are rejected before HTTP. Unknown or mixed-operation routes without a reliable category stay denied. Raw `callApi` is unavailable on a scoped client. The global `read-only` profile retains its existing exclusion of `genericApiCall`; category-scoped read access can expose generic GET calls with runtime enforcement.

## Permission boundaries

These are command/capability scopes. Composite diagnostics and authorized write preflights read the dependencies necessary for their defined result. A write permission can therefore return before/after evidence even without a separate read permission. This model does not provide per-record redaction or site tenancy; controller account permissions still determine available data.

Canonical route ownership, not vendor prose/tags or resource names, controls discovered/raw permissions. Device firmware actions remain maintenance operations, and gateway wireless-setting routes remain wireless operations. Mixed settings endpoints are denied when their ownership cannot be established safely. Allowed raw operations still carry their documented API semantics; a category grant is not read-back verification.

Canonical `/openapi/v1/msp/{mspId}/...` and v2 MSP routes use the separate `msp` category, rather than inheriting customer-site permissions. Set `msp:r` or `msp:rw` explicitly, or grant an `all` fallback; `system:r` alone does not grant MSP access. `OMADA_MSP_ID` is still required for execution. These scopes do not establish authentication or live MSP support.

For read-only Wi-Fi work, a scope such as `system:r,wireless:r` keeps site selection and audit commands available. For broader observation with controlled writes, start with `all:r` and add only the categories that need `:rw`.

Controller 6.3.0.45 validation confirmed denied discovery and generic writes stopped before HTTP, and server options could not broaden configured scopes or read-only access. With `all:r,clients:rw`, a guarded test created and renamed a disabled, unassigned rate-limit profile, verified both results, deleted it, and confirmed existing profiles were unchanged. The guard permitted exactly those three mutations.

`rollbackNetworkChange` follows the receipt resource: `clients:w` for rate-limit profiles, `network:w` for DHCP reservations, and `wireless:w` for SSID/AP radio changes. Listing the shared tool does not grant authority over another category; both server and configured-client checks enforce the resource at invocation.

`diagnoseSecurity` requires `security:r`. Native health and incident reads use `monitoring`; switch LLDP reads use `switching`. Incident status changes and deletions remain mutations and are denied by read-only scopes. Existing composite client/network diagnostics retain their documented command-scope permission model.

`getClientApplicationTraffic` is a clients read command; its fixed DPI/taxonomy reads are dependencies of that selected-client report. Canonical site Bonjour profile reads use network scope for mDNS reference preflight; this does not grant site-template or controller-global profile access. DNS receipt restoration requires `network:rw`, including for the state-reading rollback preview.

Compact mode applies the same restrictions to search, descriptions and dispatch. The new managed backup and SSID/WLAN/policy-route workflows require both read and write permission for their category. See [managed workflows](managed-workflows.md).

PoE schedule operations use `switching` scope. Managed create/update requires `switching:rw,network:r` for schedule/PoE-port and time-range reads; delete and disable-only updates require `switching:rw`. Time-range profile listing uses `network:r`.
