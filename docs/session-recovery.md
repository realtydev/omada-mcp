# Internal web-session recovery

Internal web-API reads can renew one expired session and repeat the original read once. This covers selected ACL, route, port-forward, topology, switch and AP SSID workflows that use web credentials. It is separate from Fusion web-mode/Open API authentication.

Recovery recognizes existing expired-session API codes/messages or HTTP 401, plus:

- A redirect to `/login` or `/{configured-controller-id}/login` on the configured hostname and port. The observed OC200 redirect may change HTTPS to HTTP; it is only an expiry signal. Redirects are never followed, and login/retry always use the original configured URL and TLS policy.
- A bounded HTML response positively identified as a POST login form with username and password inputs and a configured-controller login action. Arbitrary HTML, malformed JSON and unrelated redirects do not establish expiry.

Renewal retains the original request timeout budget. Matching CSRF invalidation and shared authentication prevent a late failure from clearing a newer session. Plain permission denials do not trigger renewal.

## Writes are never replayed

Internal POST/PUT/DELETE requests no longer automatically repeat after authentication failures, including HTTP 401 and known expiry codes. A positively rejected session is invalidated for the next explicit request, while the failed mutation reports that its outcome is unverified and that it was not replayed. Read the current settings before deciding whether to retry. Existing verified workflows may reconcile the uncertain result with reads.

Other unexpected non-API responses fail explicitly. Errors retain method, endpoint and safe HTTP/numeric error status, while omitting raw HTML and redirect locations. These responses are summarized in debug logs rather than logged as body snippets.

## Verification

Controlled real HTTP fixtures verify bounded re-login for a login redirect and login HTML, no requests to the redirect target, and no mutation replay. A failed mutation is followed by a fresh login on the next explicit read. Regression tests cover foreign hosts/ports, unrelated paths, malformed responses, permissions, response-secret omission and timeout preservation. Live-controller evidence is recorded separately by the release validation.

A login page with an unknown structure or route is intentionally refused. Add support only after capturing its safe routing/shape evidence; do not treat every redirect or HTML page as an expired session.

On the live OC200 / Controller 6.3, an isolated test session with a deliberately bogus cookie received a login redirect. The next read renewed that private session once and succeeded; a subsequent read reused it. All requests stayed on the configured HTTPS origin and no redirect was followed. The guarded run performed four reads and two authentication requests, with no configuration mutations or changes to the running MCP's cached session.
