# MSP controllers

On an Omada controller running in MSP mode, one MCP server can work with every MSP
customer. Each customer-scoped tool takes an optional `customerId`.

## How MSP controllers authenticate

Verified against a real controller (v5.15.24.19, `mspMode: true`):

- Web login, login status and the OpenAPI token only work with the **MSP ID**, the
  `omadacId` reported by `/api/info` and shown in the controller's Open API dialog. A token
  requested for a customer ID fails with `-44106 Client Id Or Client Secret is Invalid`.
- Data requests need the **customer ID** where the controller ID normally goes
  (`/openapi/v1/{customerId}/sites/...`). The MSP ID is rejected as a data scope with
  `-1005 Operation forbidden`.
- OpenAPI requests need an access token. Web-session OpenAPI (`OMADA_AUTH_MODE=web`) is
  rejected with HTTP 401 `-44116`, so use `OMADA_AUTH_MODE=oauth` with an **MSP-level** Open
  API app in Client mode.
- One login and one token serve every customer.

## Configuration

```env
OMADA_BASE_URL=https://omada.example.net
OMADA_AUTH_MODE=oauth
OMADA_CLIENT_ID=<MSP-level app client id>
OMADA_CLIENT_SECRET=<MSP-level app client secret>
OMADA_MSP_ID=<MSP ID>
OMADA_AUTH_ID=<MSP ID>
# A default customer, or the MSP ID for "no default: every call names a customer".
OMADA_OMADAC_ID=<customer ID or MSP ID>
# Optional: restrict which customers tools may act on (names or IDs).
# OMADA_MSP_CUSTOMERS=Alpha Corp,7d2c1b...
# Recommended while trying it on customer networks:
# MCP_TOOL_PROFILE=read-only
```

| Variable                                    | Meaning in MSP mode                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `OMADA_MSP_ID`                              | Enables customer routing and the `listMspCustomers` tool. Also used for `/openapi/v1/msp/{mspId}/...` discovery routes.                   |
| `OMADA_AUTH_ID`                             | Login principal for the OAuth token **and** the web logins (Fusion web mode and the internal web API). Set it to the MSP ID.              |
| `OMADA_OMADAC_ID`                           | Default customer. When it equals `OMADA_MSP_ID` there is no default and customer-scoped calls must pass `customerId`.                     |
| `OMADA_MSP_CUSTOMERS`                       | Optional allowlist of customer names or IDs. Empty or `all` means every customer the app can see. The default customer is always allowed. |
| `OMADA_SITE_ID`                             | Default site of the default customer only. Another customer with exactly one site uses that site by default; otherwise pass `siteId`.     |
| `OMADA_WEB_USERNAME` / `OMADA_WEB_PASSWORD` | Optional internal web API, logged in with `OMADA_AUTH_ID`. Use an MSP account.                                                            |

## Using it

1. `listMspCustomers` returns the customers the server may act on, with
   `customerId`, `customerName` and `isDefault`.
2. Pass `customerId` (the ID, or the exact name, case-insensitive) to any other tool,
   for example `listSites {"customerId": "Alpha Corp"}`, then
   `listDevices {"customerId": "Alpha Corp"}`.
3. Without `customerId` a tool uses the default customer. If there is none, the call is
   refused with a message pointing to `listMspCustomers`.

Unknown, ambiguous or non-permitted customers are refused before any request is sent to
the controller. Tools that don't touch customer data (`listMspCustomers`, `getServerInfo`,
`searchApiOperations`, `describeApiOperation`, `refreshApiCatalog`) take no `customerId`.

All customers share one HTTP client, one OAuth token and one web session. Concurrent
calls for different customers are kept apart per call.

## Limitations

- Web-session OpenAPI (`OMADA_AUTH_MODE=web`) does not work on MSP controllers (HTTP 401
  `-44116`). Use OAuth with an MSP-level app.
- Write tools act on the selected customer's network. Use `MCP_TOOL_PROFILE=read-only` or
  `OMADA_MSP_CUSTOMERS` to limit the risk.
- The WAN failover guard (`omada-wan-guard`) uses `OMADA_OMADAC_ID` only, so it covers one
  customer.
- Verified live (read-only) on a v5.15.24.19 MSP controller: customer listing, and sites,
  devices and clients per customer. Other tools use the same path rule but were not
  checked individually on an MSP controller.
