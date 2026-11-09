# Controller capabilities

Call `getControllerCapabilities` to read controller metadata and the shared discovery catalog. It does not change configuration, scan devices, or start RF tests.

```json
{}
```

The report contains:

- `controller`: version, metadata API version, and explicit `classic`, `msp`, or `unknown` mode from `/api/info`. Missing mode evidence stays unknown. MSP routing is currently unsupported; classic routes are not rewritten automatically.
- `configuration`: configured authentication mode, internal web credential availability, and whether a site was selected. Configured credentials do not establish successful authentication or permission.
- `catalog`: live/bundled provenance, load time, fallback indicator, operation counts, unsupported-contract reasons, and feature advertisements. Preflight eligibility is distinct from full schema validation, permissions, and hardware support. Advertisements retain `controllerSupport:"not_tested"`.
- `ssidEvidence`: an optional response-shape check for one explicitly selected SSID. The default is `not_requested`.

A metadata `apiVer` of `3` does not establish Open API v3 execution support. Discovery retains its existing supported route versions. Bundled documentation is a snapshot, and even a live document does not prove that a device implements a feature.

## Inspect one SSID

Obtain IDs through `listSites`, `getWlanGroupList`, and `getSsidList`, then provide both `wlanId` and `ssidId`:

```json
{
    "siteId": "your-site-id",
    "wlanId": "your-wlan-id",
    "ssidId": "your-ssid-id"
}
```

The configured site is used when `siteId` is omitted. No SSID is selected automatically. The result lists missing/invalid required basic fields, distinguishes missing MLO evidence from explicit `false`, and reports password presence/masking without returning its value or the SSID name. One sample does not establish the shape of every SSID or validate its complete security configuration.

Controller 6.3.0.45 omitted `mloEnable` in the observed SSID detail. This evidence explains why the update workflow requires an explicit value instead of guessing that MLO is disabled.

## Partial evidence

Sections independently report `ok`, `forbidden`, `unsupported`, `unavailable`, or `unknown`. `ok` means evidence was collected, not that a feature was validated. One failed section does not discard the others. Safe numeric controller rejection codes support classification; raw vendor error messages and credentials are excluded.

Metadata reads retain configured controller TLS, refuse redirects, and have a 10-second/256 KiB limit. Catalog discovery retains its existing document limits and per-client cache. Restart after controller firmware or discovery configuration changes to refresh the catalog.

The tool is available in full and read-only profiles. Guarded hardware validation can read metadata/catalog evidence and one explicitly selected SSID without mutations.

Guarded validation on Controller 6.3.0.45 reported classic mode, a bundled 1,676-operation catalog, and missing `mloEnable` for the selected SSID. Metadata API version `3` remained separate from execution support. No controller settings were changed.
