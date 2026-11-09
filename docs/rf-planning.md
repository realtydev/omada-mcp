# Read-only RF planning report

`getRfPlanningStatus` combines controller RF planning configuration, current state, successful-deployment evidence and one history page. It never starts or cancels scans, applies recommendations or restores a plan.

```json
{
    "historyPage": 1,
    "historyPageSize": 20
}
```

`siteId` is optional and resolves through the normal configured-site selection. History pages start at 1; page size defaults to 20 and is limited to 100. Set `planningHistoryId` from a returned record's native `planningHistroyId` to include per-device/radio details for that run. The misspelled native field name is retained for compatibility.

## Evidence contract

Four documented v1 GETs are collected independently:

| Section         | Endpoint                             | Meaning                                                                                                                        |
| --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `configuration` | `/sites/{siteId}/rfPlanning`         | Recognized deployment flags, schedule enablement/basic occurrence, exclusions, mode/resource and any returned planning detail. |
| `current`       | `/sites/{siteId}/rfPlanning/result`  | Native status and optional before/after indexes, failure type and run ID.                                                      |
| `deployment`    | `/sites/{siteId}/rfplanning/history` | `firstDeploy:true` means **no successful deployment yet**. It does not mean no historical attempts.                            |
| `history`       | `/sites/{siteId}/planningHistory`    | Requested page of historical attempts, preserving missing/null scan and apply outcomes.                                        |

An optional fifth GET, `/sites/{siteId}/planningHistory/{id}`, provides bounded per-device details and original/recommended radio settings. Reading a recommendation does not apply it. Device detail is limited to 256 entries; unrecognized fields are stripped and strings are bounded. This is a recognized-field report, not a raw configuration export.

Native result status is retained alongside a label: `0:completed`, `1:no_result`, `2:planning`, `3:canceling`; future numeric values get `unknown`. Completion and before/after indexes do not establish healthy RF conditions, applied configuration or client performance. Failure type and historical success fields remain separate evidence.

Each section has its own source, collection time and `ok`, `forbidden`, `unsupported`, `unavailable` or `unknown` state. A failure does not erase other sections. Malformed or unrecognized responses are unknown, never successful empty history. Controller errors are reduced to safe status/code evidence without raw messages or bodies. HTTP 404 indicates that the requested evidence route is unavailable; it does not prove why a particular history ID is absent.

`collectionComplete` means every requested section produced usable evidence. It does not mean every historical page was read. History explicitly reports `scope:"requested_page"`, requested page/size, optional total count, `hasMore` and `completenessKnown`. Missing metadata leaves continuation unknown. Wrong page/size, oversized or duplicate records and inconsistent known counts are rejected as unknown evidence. There is no automatic unbounded pagination.

History timestamps remain in controller-native units; collection timestamps are server epoch milliseconds. No unit conversion, freshness or current health is inferred from historical records. Reads are not an atomic snapshot, and availability of a read endpoint does not prove permission to optimize.

The tool belongs to `wireless` and is available in the global read-only profile and `wireless:r`. Planning-history discovery routes share that category. No new credentials, write endpoints or controller state are required.

## Validation

Unit and real MCP contract tests cover native/future status codes, failed historical attempts, partial failures, denied/unsupported reads, missing and malformed evidence, bounded pagination, detail projection and scoped profiles. Live validation reads the controller over HTTP MCP with a transport guard permitting only GET/HEAD and exact authentication requests; optimization is never triggered.
