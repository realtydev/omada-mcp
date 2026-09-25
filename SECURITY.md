# Security Policy

Omada MCP can read and change live network configuration, so we take security reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through [GitHub Security Advisories](https://github.com/realtydev/omada-mcp/security/advisories/new).

Include the affected version (`getServerInfo` reports it), the transport (stdio or HTTP), and steps to reproduce. You should get an acknowledgement within a few days.

## Supported versions

Only the latest release receives fixes.

## Deployment notes

- The HTTP transport has no built-in authentication. Keep `MCP_HTTP_BIND_ADDR=127.0.0.1` (the default) or put it behind an authenticating reverse proxy, and don't enable ngrok on a server with write access unless you understand the exposure.
- Scope Open API credentials to the minimum role you need, and treat `.env` files as secrets.
