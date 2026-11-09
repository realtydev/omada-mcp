# Managed switch port coverage

`getSwitchPortOverview` reads managed-switch inventory, public switch configuration, site-wide PoE port telemetry and (when configured) the controller web API's switch detail. The web read includes non-PoE switches omitted by the PoE endpoint. No switch configuration, scan or cable test is started.

The report includes `ports` and per-switch `switches` coverage: `inventoryKnown`, known/telemetry port counts, source states and `complete`, `partial` or `unavailable`. `collectionComplete` means the selected managed-switch port inventories and link evidence were established without inventory ambiguity or truncation. Source failures remain visible even when a fallback establishes complete coverage. It is not a health or connectivity guarantee.

`listSwitchPorts` retains its array response and uses the same complete reader. It includes configuration-only ports with `operational.status:"unavailable"` if live telemetry cannot be read. If an entire port inventory cannot be established, it fails with a pointer to the coverage report instead of silently omitting that switch. Empty or malformed device details do not establish a switch with zero physical ports.

Per-port `configured` fields are administrative/configuration evidence. `portStatus` and `operational` contain telemetry. An enabled administrative port can have a down physical link; its configured `status` is never substituted for `linkUp`. The existing PoE telemetry scalar fields remain available. `operational.negotiatedSpeedMbps` is returned only for an up link with a unique conversion from the controller's own port capability labels. Unknown codes stay unconverted. Missing PoE capability is not guessed from a stored PoE mode or current power state.

Ports are joined by switch MAC plus stack unit, slot and physical port. Duplicate identities, mismatched switch identities and inconsistent source inventories cannot establish complete coverage. Only selected bounded fields are returned from web detail; arbitrary configuration and credentials are excluded.

Reads are independent and may be cached. Controller sampling freshness is unknown. Collection is bounded to 1000 inventory devices, 64 switches, 512 ports per switch/source, 8192 primary telemetry rows and a 30-second start budget, with at most four switches collected concurrently. In-flight requests retain their normal timeouts. Truncation and per-source failures are explicit; raw controller errors are not returned.

Both tools belong to `switching` and are available in read-only mode and `switching:r`. Gateway-integrated and unmanaged ports are outside this managed-switch inventory. Without web credentials, configuration coverage remains useful but non-PoE telemetry may be unavailable. Existing switch mutation-preservation and safety readers remain unchanged.

Live qualification on Controller 6.3.0.45 compares every compound port identity and link state against independent guarded web reads. The three-switch inventory has 38 physical ports (10 SG2210XMP-M2, 18 SG2218P and 10 non-PoE SG3210X-M2), compared with 28 rows from the PoE endpoint alone. This establishes the tested controller contract, not universal firmware compatibility.
