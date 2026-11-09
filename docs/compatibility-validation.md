# Controller compatibility qualification

Compatibility has two separate forms of evidence: controlled protocol/schema fixtures, and reads against a real controller. A passing fixture does not establish device support.

## Repeatable hardware checks

From a repository checkout, install the locked dependencies and run `yarn build`. Keep credentials in a private local file and select it explicitly:

```sh
OMADA_ENV_FILE=/private/path/controller.env yarn smoke:compatibility --expect classic
OMADA_ENV_FILE=/private/path/msp.env yarn smoke:compatibility --expect msp
OMADA_ENV_FILE=/private/path/fusion.env yarn smoke:compatibility --expect fusion
OMADA_ENV_FILE=/private/path/controller31.env yarn smoke:compatibility --expect openapi31
```

Repeat `--expect` to require multiple surfaces. The runner forces the global read-only profile and installs a request guard before constructing the client. It permits only reads and the exact authentication POST endpoints on the configured controller; redirects remain disabled. It never starts scans, speed tests, firmware operations or configuration changes. Existing category restrictions remain in force.

Output includes counts, observed mode, source, bounded HTTP/numeric controller error codes and explicit untested reasons. It excludes identifiers, URLs, credentials, raw messages and response bodies. Exit 0 means the requested checks passed, 1 means validation/request failure, and 2 means the required environment or specification was unavailable. A missing environment must not be reported as a pass.

`msp` requires configured `OMADA_MSP_ID` and a successful schema-validated read through an MSP site-list route. OAuth principal (`OMADA_AUTH_ID`), customer/controller context and MSP route context remain separate. Category-scoped configurations need `msp:r` or an appropriate `all` fallback.

`openapi31` requires a live OpenAPI 3.1 specification and a successful schema-validated site read. A 3.0 bundled fallback does not qualify.

`fusion` means the operator supplied a Fusion test environment and the web-authenticated read succeeded. The command tests that authentication/read workflow, not the device's marketing identity or expired-session recovery. It does not force another user's session to expire.

## Expired Fusion sessions

Real expired-session recovery remains unqualified until a Fusion controller supplies its actual HTTP status and numeric error code. The current OC200 cannot provide that evidence. Unknown `login required` codes are not added to retry rules speculatively: doing so could replay a mutation after a permission rejection.

The runner records safe numeric errors when they naturally occur. For issue #14, use that evidence with the controller/firmware version and a description of the read that failed; do not publish cookies, tokens, passwords, controller identifiers or raw response bodies. Add the captured expiry contract as a regression before extending renewal classification. Permission denials and uncertain mutations must retain their existing refusal/no-replay behavior.

## Current evidence

- OC200 / Controller 6.3: live classic reads, automatic discovery fallback, diagnostics, file exports and disposable configuration workflows are validated separately in the workflow documentation.
- MSP and OpenAPI 3.1: end-to-end MCP fixtures cover route/principal separation, scope refusal, live-spec loading and schema validation before writes. Real deployments are still needed.
- Web authentication: MCP fixtures exercise one bounded renewal for an established session-expiry message, and no renewal for permission denials or an unrecognized login-required code. These are controlled cases, not captured Fusion firmware responses.

The available hardware returns HTTP 404 at the three supported Swagger documentation probes. `refreshApiCatalog` exposes that evidence while continuing to identify the bundled fallback; it does not imply an authentication fault or probe unrelated endpoints.
