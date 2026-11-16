# Verified DNS changes and rollback

Canonical LAN DNS and mDNS rule writes use the existing discovery search, describe and execute tools. Normal write previews remain `dryRun:true` and send no controller requests. Actual writes require network read and write permission and use one mutation with bounded read-back; uncertain mutations are never replayed.

An acknowledged, verified change may return a version-1 `rollbackReceipt` for `lan-dns` or `mdns-rule`. Receipts contain controller/site scope, the original/applied row identities and only the supported writable configuration. Keep the JSON receipt in your client if you want to undo a change. They are configuration evidence, not authorization tokens; controller credentials and current tool permissions still govern restoration.

Pass the receipt to `rollbackNetworkChange`. It defaults to a preview; set `dryRun:false` explicitly to restore. Unlike ordinary discovery previews, rollback previews read current state to verify that restoration is still applicable. A mDNS restoration additionally checks the referenced Bonjour profiles and LAN networks.

Restoration refuses changed/replaced targets, conflicting names/domains, malformed or incomplete collections, unsupported catalogue contracts and receipts for another controller. It checks the applied snapshot again inside the verified write preflight. Other reported entries must remain unchanged for verification to succeed. No conditional-write API is established, so a race after the final preflight read remains possible; avoid concurrent edits to the same records.

- Undoing a create deletes that exact verified row.
- Undoing an update restores the original supported fields on the same row ID. Updates that introduce or remove optional field presence do not issue receipts because a preserving PATCH cannot reliably remove a field.
- Undoing a delete recreates the original configuration. The controller assigns a new row ID; repeated restoration is a verified no-op when that exact configuration already exists.

No receipt is issued for a no-op, an unverified result or a lost acknowledgement, even if later reads observe the desired state. A missing acknowledgement remains `written:"unknown"`. Inspect current configuration before an explicit retry. Successful verification establishes reported configuration only; it does not prove DNS resolution, multicast reachability or application behavior.

Fixtures cover both resources' create/update/delete restoration, preview/no-op behavior, same-name replacements, drift between planning and preflight, sibling preservation, scope/controller binding, invalid receipts, irreversible optional-field changes and lost acknowledgements. Hardware validation is recorded separately by the release checks.

LAN DNS address fields validate IPv4/IPv6 syntax, reject scope-zone/CIDR/hostname substitutes and retain fixed record-count limits. Domain, alias and CNAME targets must be bounded fully qualified names. The bundled vendor schema repeats array counts as several per-item string lengths. Canonical LAN DNS validation corrects only the exact known alias/IPv6/forward-server duplicates, using bounded name/address lengths and retaining count limits. Guarded OC200 calibration created disabled `.invalid` records with a valid forward-server IPv4 target and a long IPv6/alias, verified their reported values, deleted them and checked the original collection was restored. Different future schema constraints remain enforced; other operations are not normalized.

LAN selection is mode-specific: IP and CNAME records require at least one selected LAN network; FORWARD records omit `lanNetworkIds`. The controller's observed forwarding response omits that property, and the verified workflow refuses a submitted LAN selection rather than pretending that an ignored scope was applied. Omission remains distinct from an empty selection. Record-type changes are refused before mutation until their field transitions are qualified; create an explicit replacement instead. Same-type updates preserve supported fields and retain normal receipt eligibility.

Hardware qualification used disabled, uniquely named DNS/mDNS fixtures. Create/update/delete, no-ops, update/delete restoration, replacement/drift refusal and deliberately lost acknowledgements were checked; cleanup preserved the original collections. IPv4/long IPv6/alias, CNAME and forward records were exercised. No active forwarding or name-resolution behavior is inferred from those configuration checks.
