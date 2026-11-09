# Automatic API discovery

The existing tools remain available. Three additional tools let an assistant search the controller's API, inspect an operation, and execute a validated JSON request without needing a separate MCP tool for every endpoint.

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

Discovery loads lazily and shares one cached snapshot per client process. Restart after changing controller firmware or discovery configuration. Every search, description, and execution identifies its `source` and `loadedAt`; fallback searches/descriptions also explain why the bundled snapshot was selected. The bundled snapshot currently indexes 1,676 operations. A listed operation does not establish that a particular controller/device implements it.

Documentation requests stay on the configured controller, retain TLS verification/private-CA configuration, refuse redirects, and are bounded in size and duration. External schema references are not fetched. Split documentation groups must load consistently; partial or conflicting groups trigger fallback in `auto` mode or failure in `live` mode. Descriptions disclose unresolved references and bounded expansion.

## Execution and existing safeguards

JSON execution validates declared required parameters, schema types, enums, ranges and supported JSON Schema constraints. It rejects unknown parameters, unsafe path values, caller-supplied controller IDs, custom authentication headers, unsupported serialization and invalid schemas. OpenAPI 3.0 is supported; vendor prose and unknown format names are not executable validation rules. Binary/form/multipart operations, explicit non-JSON downloads, MSP-scoped paths and unsupported schema dialects cannot be executed through discovery.

GET executes normally. Writes default to a preview with `dryRun:true` and `written:false`; only an explicit `dryRun:false` sends a mutation. Previews do not claim that the controller will accept the request. Actual writes report `verified:false`, meaning no automatic read-back verification was performed. A successful response is not proof that hardware applied the setting. Errors preserve controller details and warn that a failed write may have applied; discovery does not replay uncertain writes.

Use the existing dedicated tools where they provide stronger workflows. Radio configuration, DHCP reservation, SSID basic configuration and log-notification mutations can be previewed through discovery, but execution directs callers to their dedicated tools to preserve preflight checks, preservation, reconciliation and read-back verification.

`MCP_TOOL_PROFILE=read-only` exposes all three discovery tools but limits search, describe and execution to GET operations. Writes, including write previews, are rejected independently in the execution layer. Read-only means no mutations; controller permissions still govern access to returned information. Credentials in tool/request logs are redacted; tool results remain usable controller data.

Each execution performs one API request/page. Required pagination defaults to `page:1` and a schema-bounded `pageSize` of at most 100; supply documented page parameters to fetch later pages. Prefer the existing list tools when you want their fetch-all behavior. Request/response sizes and schema expansion are bounded.

## Reviewing a bundled specification update

Run `yarn api:refresh --source /path/to/controller-openapi.json` to compare an explicit controller or TP-Link document with the full bundled snapshot. An HTTPS source URL is also accepted; it must not contain credentials, query parameters or a fragment. Fetches refuse redirects and have a 10-second timeout and 16 MiB size limit.

The JSON report includes source identity, versions and hashes, added/removed HTTP method/path pairs, and changed operations, including changes to referenced request and response schemas. Reordering object keys produces no change; array order is preserved. `info.version` alone does not establish controller or hardware compatibility.

The command is report-only unless `--write` is supplied. Adoption atomically replaces `docs/openapi/00-all.json`, leaving split historical snapshots unchanged. Incomplete or external references appear as warnings; changed documents with those warnings require manual review before adoption. The existing bundle contains a malformed vendor reference, so a no-op comparison can report `comparisonComplete:false`. Discovery continues to disclose unsupported operations independently. Exit 0 means comparison/adoption succeeded; exit 1 means invalid input or a fetch/write failure. Review schema changes and run the checks before shipping a refreshed snapshot.

## Validation

Run `yarn build`, then `yarn smoke:discovery` with controller credentials in `.env`/`.env.local`. The script installs a guard that permits controller reads and authentication only, exercises search/describe/execute, and checks that write attempts are rejected before reaching that guard. Output contains counts and status without network identifiers.

OC200 / Controller 6.3.0.45 validation used the bundled fallback because the standard documentation routes were unavailable. Discovered site, device, client, Wi-Fi summary and rate-limit profile reads passed. A separate guarded test created one unassigned profile with both limits disabled, verified it, deleted it and verified removal. Live specification loading, malformed/conflicting documents and unsafe references have controlled fixture coverage.
