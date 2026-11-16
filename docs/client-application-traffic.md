# Per-client application traffic

`getClientApplicationTraffic` reads application evidence for one explicitly selected client. It never enumerates every client, enables DPI or traffic logging, changes application controls, or starts a speed test.

```json
{ "clientMac": "AA-BB-CC-DD-EE-FF", "maxApplications": 100 }
```

The configured site is used unless `siteId` is provided. Optional `start` and `end` are epoch seconds; the default window is the last hour and the maximum is 24 hours ending at or before now. The window applies only to traffic. `maxApplications` bounds returned traffic rows to 1–500, default 100.

The workflow independently reads three fixed Open API v1 endpoints:

- `applicationControl/status`: reported DPI and traffic-logging settings.
- `applicationControl/applications`: one metadata page of at most 1,000 applications.
- `dashboard/specificClientInfo/{clientMac}`: the selected client's application traffic for the requested window.

Each read refuses redirects and has a 10-second timeout and 2 MiB response limit. Source failures remain independent and retain only safe HTTP/controller codes, never raw vendor errors. Unsupported gateways, absent gateways and DPI protocol updates remain explicit when the controller reports their documented codes.

## Evidence and identity

When reported, numeric `time`, `timestamp`, `start` and `end` fields retain their original values under `reportedTimes`, with units explicitly unspecified. They are not converted or treated as proof of source freshness.

Traffic retains reported `applicationId`, optional `applicationName`, and recognized `upload`, `download`, `traffic`, `up`, `down`, packet-counter and percentage fields. Real zero is retained; invalid, negative, non-finite or unsafe numeric values are omitted with missing-field evidence. Missing values are never filled with zero. The endpoint's byte units, counter resets, aggregation semantics and measurement timestamp units are not established, so the tool does not calculate rates, convert to bytes or sum competing counter fields.

Metadata joins require exact ID type/value agreement and a complete, untruncated, valid metadata page. The documented `applicationName` and observed controller `application` aliases retain their source; contradictory aliases are refused. Duplicate metadata identities suppress joins. Incomplete metadata is summarized with counts and coverage, rather than returning the entire application taxonomy.

Traffic rows retain their own reported names even without a metadata match. Truncated traffic suppresses joins because unseen identities could conflict. Duplicate traffic identities remain separate ambiguous evidence; the tool does not select or aggregate them. Explicit foreign-site or foreign-client rows are excluded. Unknown fields and nested configuration details are omitted.

`recording` is `disabled` only when a returned DPI or traffic-logging setting is explicitly false, `enabled` when both are explicitly true, and otherwise `unknown`. Missing logging status does not become false. These current settings do not establish whether historical traffic exists. Empty traffic remains partial evidence, not proof of zero usage, an offline client or a healthy connection.

`collectionComplete` describes coverage of these bounded reads, not complete application visibility or measurement freshness. Applications may remain unidentified, encrypted traffic can limit classification, and controller caches may be stale.

## Hardware qualification

The available OC200 / Controller 6.3 initially returned `dpi:false` and omitted `loggingTraffic`; later reads reported both enabled. The validation scripts made no DPI or logging changes. Its application taxonomy used the `application` name field and reported 2,788 applications, exceeding the bounded metadata page. Selected-client and three top-client reads returned empty arrays in both the observed availability states. Qualification covers live availability, empty and partial evidence handling; positive traffic, metadata joining and malformed/failure cases have controlled fixtures.
