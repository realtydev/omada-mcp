# Bounded file transfers

`executeApiOperation` supports declared multipart uploads and GET file downloads. File transfers require the full tool profile and an operator-configured directory; they are blocked in read-only mode, including download previews. Existing authentication, TLS, redirect restrictions and operation-schema validation still apply.

## Configure storage

Set `OMADA_TRANSFER_DIR` to an existing absolute directory controlled by the server operator, without group/world write access. The MCP process must be able to read uploads and create downloads there. `OMADA_MAX_TRANSFER_BYTES` defaults to 16 MiB and can be set from 1 byte through 64 MiB. Upload file bytes share that limit; at most eight files are accepted. JSON fields retain their separate request limit.

Linux and macOS provide the required no-follow filesystem primitives. Hosts without those primitives must use the Docker server for file transfers. On Linux, child file opens are anchored to an open directory descriptor. Directory identity is rechecked around opens on every host. The operator must keep the directory and its ancestors under trusted control and must not replace them while transfers run; this is not a sandbox against a hostile process running as the same host user.

For Docker, mount the directory at `/transfers`, make it accessible to the container's `node` user (UID 1000), and set `OMADA_TRANSFER_DIR=/transfers`. A private named volume is suitable. Fresh runtime Docker setup automatically binds a configured host transfer directory to `/transfers`; it does not change its ownership or permissions. For an adopted Compose service, configure the mount and container path before adoption.

## Upload

1. Stage the file inside the configured directory.
2. Search and describe the operation. Only declared binary multipart fields are accepted.
3. Pass `files`, mapping field names to basenames, and `body` for other multipart fields. For example, `{"operationId":"uploadPortalPic","files":{"file":"picture.png"}}`.
4. Inspect the default preview. Set `dryRun:false` explicitly to upload.

A preview reports field names, filenames and sizes without sending file contents. Declared arrays of binary files accept filename arrays. Ordinary object fields are sent as JSON parts. Explicit non-default multipart encoding metadata remains unsupported and is rejected rather than silently changing its meaning. The operation's own controller effects still apply; uploading firmware or changing a certificate is not a harmless test.

## Download

Supply `downloadFile` for a GET operation that returns file bytes, for example `{"operationId":"<discovered-file-operation>","params":{},"downloadFile":"backup.cfg"}`. `dryRun:true` previews without creating a file. Execution saves a new file with private permissions and reports its name, byte count and SHA-256 hash.

The server rejects path separators, hidden filenames, symlinks, special files, existing targets, oversized data, HTML login pages and API error envelopes. It never overwrites a target, even when that target appears after preview. API responses containing a download URL remain ordinary JSON; the server does not automatically follow external links or redirects.

A local write failure may leave a partial new file for explicit inspection; use a new filename or remove that partial file yourself. Controller errors in byte responses retain bounded authentication handling without logging file contents. These transfers are memory-bounded rather than unlimited streaming; raise the configured cap deliberately for larger files.

Multipart and binary wire behavior is tested against an isolated HTTP fixture with real Axios serialization, including preview, persistence, metadata and refusal paths. No active firmware upload, certificate change or controller restore is used for live validation.
