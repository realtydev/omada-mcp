# PoE power evidence

PoE detail extends existing read-only workflows; no new tool or configuration mutation is required.

## Dashboard detail

The default `getSiteDashboard` response keeps its existing compact switch-level PoE summary. To include port detail and reported headroom:

```json
{ "includePoePorts": true }
```

The same five controller reads are used, including the v1 `dashboard/poe-usage` endpoint. Rich PoE rows expose validated `totalPower`, `totalPowerUsed`, `totalPercentUsed`, `headroomWatts`, and bounded `poePorts` with `portId`, `poeSupported`, `poeEnabled`, `poePower`, and `poePercent` when present. Each row identifies `source:"dashboard-poe-usage"`, status, and missing fields.

Power values retain the controller's watt units, including a real zero. Headroom is the reported positive switch budget minus its reported draw; a negative result means those reported numbers exceed the budget. No headroom is inferred from a missing/invalid/zero budget. Switch `totalPercentUsed` is relative to its switch budget. Per-port `poePercent` is the controller's port-relative percentage; it is not the switch-budget percentage, and no port watt limit is derived from it.

A disabled port with omitted power readings stays unknown, not zero. Explicit `poeSupported:false` means unsupported and does not fabricate power metrics. Empty/missing port arrays, malformed identities, duplicate ports, invalid numbers and out-of-range percentages are disclosed as partial evidence. Every duplicate port identity is excluded rather than selecting one reading. Duplicate switch identities invalidate the PoE source. Other dashboard sections remain available.

The rich section retains `status:"ok"` when it has usable data, with `partial:true` for incomplete PoE evidence. Per-switch/port statuses identify the missing detail; dashboard `collectionComplete` stays false for partial or truncated collection. That is evidence coverage, not a network health verdict. The vendor's `portNum` has varied between firmware/device classes, so it remains a reported count and is never treated as physical-port inventory authority.

## Switch port overview

`getSwitchPortOverview` and its legacy `listSwitchPorts` array retain their inventory and link evidence. They additionally read the same PoE dashboard source. Per-switch `poeUsage` contains switch-level power evidence; per-port `poeUsage` supplies the matching port power evidence. Existing telemetry fields are not overwritten, and each power row names its source.

Dashboard rows never add switches or ports to the established inventory. Port power joins require an established standalone physical inventory. The flat dashboard `portId` lacks stack unit/slot information, so stacked, ambiguous or unestablished inventories receive an explicit unavailable mapping reason instead of a guessed join. A missing dashboard port is not classified as unsupported. Truncated dashboard switch/port evidence is not joined to switch or port identities, because unseen rows could contain conflicting duplicates; bounded prefixes remain visible in the partial dashboard report. Source errors remain visible separately from inventory/link coverage; power-source failure does not erase valid link evidence or change the meaning of `collectionComplete` in the switch overview.

## Limits and freshness

PoE dashboard detail is bounded to 50 switches and 512 reported port rows per switch. Truncation is explicit; the overview reports `poeUsageTruncated`. These bounds do not change its existing managed-switch inventory limits. Gateway-integrated and unmanaged ports remain outside that inventory.

Reads are not atomic and controller telemetry can be cached. Capture time does not establish measurement freshness. No scan, cable test, reconnect, port enablement or power-setting change is performed.

## Live validation

OC200 / Controller 6.3 read-only validation observed three switches: one explicitly non-PoE, one PoE switch reporting real zero draw, and one with a powered port. The richer dashboard preserved 23 disabled ports with omitted power readings as unknown, while the overview joined 38 unambiguous physical ports. Default dashboard output remained compact. The guarded run performed 19 reads and two authentication requests with no configuration mutations.
