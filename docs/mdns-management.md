# Verified mDNS rules

The existing discovery tools provide canonical site mDNS management; no additional CRUD tool names are registered:

1. Find and describe `getMdnsGrid`, `listMdnsProfile` and `getLanNetworkList` to obtain current rules and valid reference IDs.
2. Describe `createMdns`, `modifyMdns` or `deleteMdns` before submitting a configuration.
3. Preview with `executeApiOperation` (the default), then set `dryRun:false` explicitly to apply a reviewed change.

```json
{
    "operationId": "createMdns",
    "body": {
        "name": "Reviewed service discovery",
        "status": false,
        "profileIds": ["existing-bonjour-profile-id"],
        "type": 1,
        "osg": {
            "serviceNetworks": ["existing-service-network-id"],
            "clientNetworks": ["existing-client-network-id"]
        }
    }
}
```

The example is a preview of a disabled rule. It does not create a Bonjour profile, enable discovery or establish that a device will be reachable. Use actual IDs read from the selected site. Bonjour profile management and site templates remain separate resources with their own API contracts.

## Validation and preservation

Actual rule changes require network read and write permission. Previews make no HTTP requests. Create requires an explicit mode: `type:0` uses AP `ap.serviceVlan` and `ap.clientVlan`, while `type:1` uses gateway `osg.serviceNetworks` and `osg.clientNetworks`. Selected profile/network IDs must be nonempty, unique and present in complete bounded inventories. VLAN identifiers and increasing comma/range lists must stay within 1–4094. Duplicate or overlapping client VLAN ranges are rejected; comparisons merge adjacent intervals without expanding their members. The exact legacy vendor VLAN regex is translated only for these canonical mDNS writes, and stronger curated VLAN checks still apply.

Updates preserve omitted known writable fields, including reported inactive mode configuration. The selected mode must have its required configuration. Unknown submitted fields, malformed nested settings, missing targets, conflicting names and incomplete or ambiguous evidence fail explicitly. Schema-required update fields still have to be supplied; a preview does not read current state to fill them in.

Before a changed create/update, the workflow checks selected Bonjour profiles and, for gateway rules, LAN networks. It then rereads the rule collection and refuses intervening rule drift. Unchanged updates and already-absent deletes are verified no-ops. Delete does not depend on still-existing profile/network references, so an invalid rule can be removed safely by its exact identity.

## Mutation and verification

One mutation is sent with automatic retry disabled. Read-back polls at most three times and checks the target identity, desired/preserved known fields and unchanged siblings. Controller acknowledgement and observed configuration are separate: a missing acknowledgement stays `written:"unknown"`, even if read-back establishes the desired state. Inspect current state before an explicit retry. No automatic rollback is attempted after uncertainty.

Complete collection supports the observed bare-array and grid envelopes, with at most 1,000 records and ten pages. Profiles use their documented unpaginated list; network inventories are paginated. These bounds limit reads rather than guaranteeing an overall duration; each request retains its configured timeout. Concurrent changes after the final preflight remain possible because the controller provides no established conditional-write contract.

Verified acknowledged mutations can return a portable `rollbackReceipt`. Pass it to `rollbackNetworkChange`, which defaults to a state-checked preview; applying restoration requires `dryRun:false`. Receipts bind controller, site, resource and row identity. Update restoration requires stable known field presence; a prior configuration that cannot pass the supported create contract does not receive a receipt. Unknown acknowledgements and unverified mutations never issue receipts. Rollback refuses intervening edits and same-name replacements; restored deleted rules can receive a new controller ID.

Verification covers reported known rule fields. It does not prove multicast forwarding, endpoint discovery, application connectivity or absence of undocumented controller changes. Validate application behavior separately after any intentional enabled rule change.
