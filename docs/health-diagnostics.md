# Native health, incidents and LLDP evidence

`diagnoseNetwork` now includes `sections.nativeHealth` and `sections.lldp`. `diagnoseClient` adds `sections.lldp` for managed switches already present on the controller-discovered attachment path. Existing path nodes are preserved; LLDP does not invent a replacement path.

These additions issue only fixed GET requests. They do not acknowledge, resolve or delete incidents, start scans, modify LLDP settings or change topology.

## Native health and historical incidents

The combined diagnosis uses its existing 1–24-hour log window for two independent reads:

- Site health timeline: `/sites/{siteId}/health/timeline`, with `start` and `end` in epoch milliseconds.
- Incident aggregates: `/sites/{siteId}/anomaly/incidents`, with millisecond `filters.startTime`/`filters.endTime` and one page of at most 100 records.

The timeline preserves up to 512 timestamped native site/device/client/Wi-Fi/WAN scores. A real score of zero is preserved; missing, negative, malformed, duplicate-time and out-of-window evidence is partial. The report does not invent a score scale or interpret an undocumented threshold. An empty timeline is missing evidence rather than a healthy score.

Incident rows preserve bounded anomaly/category/severity/status identifiers, counts and first/last occurrence times. Status codes stay controller-native. Historical aggregates, including records marked resolved, are not independent proof of the client's current state. The report excludes free-form title/content maps, raw error bodies and unrelated configuration fields.

## LLDP corroboration

A combined diagnosis reads one page of at most 100 LLDP neighbors from each of at most eight managed switches. A client diagnosis reads at most four distinct switches already on its topology path, plus their existing switch-port overview. LLDP sources identify collection time; that is not a packet measurement timestamp.

Each switch retains its bounded neighbor evidence and a separate `correlations` list. A correlation requires all of:

- A complete, untruncated LLDP page with consistent page metadata and no duplicate local port identities.
- An exact MAC-format advertised device ID matching one unique managed device; names never establish identity, and self-neighbors are refused.
- A positive reported TTL. The report does not infer elapsed freshness or cable connectivity from that value.
- Established, unambiguous standalone switch inventory, with matching unit 1 / slot 0 / physical port identities. Stacked, truncated, conflicting or unknown inventory is not guessed.
- Agreement between every supplied port identity. The live OC200 uses `standardPortIndex:{unit,slot,port}`; the documented `standardPort` string is also accepted when qualified and consistent. A malformed or contradictory index prevents a join.

Client-path correlations additionally require that the neighbor is adjacent to that switch on the existing topology path. No correlation asserts that unmanaged intermediate devices are absent. LLDP can corroborate a controller relationship, but does not prove a complete physical cable path.

## Partial collection and compatibility

Forbidden, unsupported, unavailable and malformed evidence remain explicit, with sanitized numeric status metadata where available. Failure of a new source does not discard existing diagnostic sections. Incomplete native sources make the combined collection partial; they do not establish a network fault. Diagnostics retain existing controller/site scope and read-only profile behavior.

Individual reads have a 10-second timeout and 1 MiB response limit. Returned projections have fixed score, page and switch caps. A requested window exceeding 24 hours, a future end or an invalid switch MAC is rejected before a request is sent. No automatic widening or fallback to mutation endpoints is attempted.

## Live OC200 observations

A guarded Controller 6.3 read returned health-timeline rows whose five score fields were all `-1`; these remain missing score evidence. The controller also returned an earlier rounded time bucket outside the requested window. That bucket is excluded and disclosed as invalid/out-of-window evidence; the report does not silently widen its query. An incident page with no records remains a complete empty page only when its pagination metadata is consistent. These results do not establish a healthy network.

## Live validation

Guarded OC200 / Controller 6.3 validation read native health and incident contracts, LLDP from all three managed switches, and one client diagnosis through the MCP protocol. Five neighbor records produced four qualified managed-device/physical-port correlations. Health collection retained 143 in-window timestamps with 715 missing score fields: the controller reported `-1` sentinels, and an earlier rounded bucket was excluded. The native timeline correctly remained partial. No incident, LLDP, topology or network setting was changed.
