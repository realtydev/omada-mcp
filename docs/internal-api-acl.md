# Omada Internal API - ACL Endpoints

The Omada Open API (`/openapi/v1/...`) does NOT support firewall ACL management on OC200 hardware controllers.
ACLs are only available via the **internal web UI API** (`/{omadacId}/api/v2/...`).

## Authentication

### Login

```
POST /{omadacId}/api/v2/login
Content-Type: application/json

{"username": "...", "password": "..."}
```

Response:

```json
{
  "errorCode": 0,
  "result": {
    "omadacId": "...",
    "token": "36cade06669947dc9abc7382b4e0c6a0"  // CSRF token
  }
}
```

All subsequent requests need:

- Cookie from login response (session cookie)
- Header: `Csrf-Token: {token}`

## ACL Endpoints

### List ACL Rules

```
GET /{omadacId}/api/v2/sites/{siteId}/setting/firewall/acls?type={type}&currentPage=1&currentPageSize=100
```

Type values:

- `0` = Gateway ACL (LAN→WAN, LAN→LAN, WAN→LAN)
- `1` = Switch ACL
- `2` = EAP ACL

Response includes metadata:

- `aclDisable` - whether ACL is globally disabled
- `supportLanToLan` - whether LAN-to-LAN rules are supported
- `supportVpn` - VPN ACL support

### Create ACL Rule

```
POST /{omadacId}/api/v2/sites/{siteId}/setting/firewall/acls
```

Body:

```json
{
  "name": "Block IoT to Trusted",
  "type": 0,
  "policy": 0,            // 0 = deny, 1 = permit (reversed from what you'd expect!)
  "status": true,          // rule enabled
  "protocols": [256],      // 256 = ALL protocols
  "sourceType": 0,         // 0 = network
  "sourceIds": ["<networkId>"],
  "destinationType": 0,
  "destinationIds": ["<networkId>"],
  "direction": {
    "lanToWan": false,
    "lanToLan": true,
    "wanInIds": [],
    "vpnInIds": []
  },
  "stateMode": 0,
  "ipv6Enable": false
}
```

### Delete ACL Rule

```
DELETE /{omadacId}/api/v2/sites/{siteId}/setting/firewall/acls/{aclId}
```

## IP/Port Groups

### List Groups

```
GET /{omadacId}/api/v2/sites/{siteId}/setting/profiles/groups?currentPage=1&currentPageSize=100
```

Built-in groups:

- `IPGroup_Any` (0.0.0.0/0)
- `IPv6Group_Any` (::/0)
- `DomainGroup_Any` (*)

## Network IDs (for sourceIds/destinationIds)

These are the LAN network IDs from getLanNetworkList:

- Default (VLAN 1): `66209b7774bc11566b993281`
- Trusted (VLAN 10): `699761ad097e025cc474a3f9`
- IoT (VLAN 20): `699761b9097e025cc474a41b`
- Guest (VLAN 30): `69976234097e025cc474a44d`

## Known Issues

- `aclDisable: true` in list response indicates ACL enforcement is globally off
- Need to find the endpoint to toggle this (may be UI-only toggle)
- The Open API ACL endpoints (`/openapi/v1/.../setting/firewall/acls`) return 404 on OC200
