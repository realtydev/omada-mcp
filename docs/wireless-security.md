# Wireless security evidence

`diagnoseSecurity` reads saved rogue-AP detections, WIDS detections and site-local unarchived IPS threat records. It performs exactly three bounded GET page reads. It never starts an RF scan, contains a neighboring AP, changes a blacklist, acknowledges threats or changes protection settings.

```json
{ "pageSize": 100 }
```

The configured site is used unless `siteId` is supplied. `pageSize` limits each source to page 1 with 1–200 records, default 100. There is no automatic pagination. Each section names its endpoint, scope, collection time, native timestamp units and independent availability status. `partial` includes truncated pages, unknown pagination completeness, malformed records, duplicate identities and excluded records. Failures retain safe numeric HTTP/controller codes while omitting raw vendor errors.

Optional `start` and `end` are epoch seconds. The default is the last 24 hours, with a maximum 24-hour window ending at or before now. This window applies **only to threat records**. The threat read uses the selected site's endpoint with `archived:false`; it never falls back to controller-wide threat access. Returned foreign-site or out-of-window threat records are excluded rather than disclosed as matching evidence.

Rogue-AP results are saved scans, with `lastSeen` in milliseconds and `signal` in dBm when reported. The WIDS endpoint provides no time filter, and its `startTime` unit is unspecified by the contract, so the report retains it without converting it or assigning freshness. Retrieval time does not establish detection time. Unknown fields are omitted; invalid rows are counted explicitly. All instances of a duplicated record identity are excluded instead of choosing one reading.

`summary` counts returned records and groups the returned threats using the controller's documented severity codes: critical, major, moderate, minor and low. These are counts from the bounded page, not complete site-wide totals. Rogue detections can include legitimate neighboring networks; the report does not infer that they are malicious. WIDS event types/levels retain native codes. No synthetic security score or healthy/unsafe verdict is computed.

`collectionComplete` describes successful complete evidence collection only. Empty, disabled, missing, denied or unavailable data does not establish safety. A controller may support one source while denying another; usable sections remain available.

## Live validation

Guarded OC200 / Controller 6.3 validation returned valid empty saved-rogue and site-threat pages. WIDS returned controller code `-1005`; its section remained `unknown` with that safe code and an unknown record count, while the other sources remained available. This validates partial-source behavior rather than establishing that the site is secure. No scan or security setting change was performed.
