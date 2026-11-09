# Runtime CLI

`omada-runtime` uses Commander for command parsing and help, Execa for subprocess execution and cleanup, and manages exact releases of the existing MCP server. Node 24+ is required. Docker mode additionally requires Docker Engine and Docker Compose v2. The CLI uses the current Docker context or `DOCKER_HOST`.

## Install

Install the runtime archive attached to the desired [GitHub release](https://github.com/realtydev/omada-mcp/releases). For example, replace `X.Y.Z` with that release's version:

```bash
npm install -g --ignore-scripts https://github.com/realtydev/omada-mcp/releases/download/vX.Y.Z/realtydev-omada-mcp-X.Y.Z.tgz
omada-runtime --help
omada-runtime setup docker --help
```

Archives include the compiled server and both `omada-mcp` and `omada-runtime` executables. No npm registry publication is required. You can download the archive and `SHA256SUMS` from the same release to check its checksum before installing. Source checkouts can use `yarn build` then `node dist/runtime.js` instead.

## Client-managed stdio

Create a credential file using the controller variables documented in the README. Restrict its permissions (`chmod 600 /absolute/path/omada.env`). The CLI references the file without editing, copying or printing its contents. It loads this one file; combine `.env` and `.env.local` settings into that file if both are needed. Environment values in the selected file take precedence over inherited values for managed stdio.

```bash
omada-runtime setup stdio --env-file /absolute/path/omada.env --version X.Y.Z --client codex cursor claude-desktop
omada-runtime doctor stdio
omada-runtime status stdio
omada-runtime update stdio --version X.Y.Z
omada-runtime update stdio --version latest
omada-runtime rollback stdio
```

With `--client`, setup configures the selected clients automatically using your absolute Node path and a stable `~/.omada-mcp/stdio.mjs` launcher. Without it, setup prints configuration you can copy manually. Each client launches its own server subprocess. There is no background stdio service. The launcher follows the selected version on the next connection.

`status` starts a fresh subprocess and verifies its `getServerInfo`. It cannot inspect an already-connected client's subprocess. Updates and rollbacks attempt to refresh registered clients and report each result. Call `getServerInfo` **inside that client** to compare its version and commit. `doctor` additionally calls the read-only `listSites` tool to verify controller access. Neither command changes controller settings.

Versions are installed under `~/.omada-mcp/versions/`. Update verifies the candidate version and build commit against the installed artifact before changing the selection. Rollback switches to the last successful selection and verifies it first. Existing processes keep running their previous build until reconnected. `--package /path/to/release.tgz` lets stdio setup/update install a local archive whose embedded version must match `--version`; dependencies still need to be available from npm/cache.

## Persistent local Docker service

For a new service:

```bash
omada-runtime setup docker --env-file /absolute/path/omada.env --version X.Y.Z --port 3000 --client codex cursor
omada-runtime doctor docker
omada-runtime status docker
omada-runtime update docker --version X.Y.Z
omada-runtime rollback docker
```

The generated Compose service restarts with Docker (`unless-stopped`) and publishes only `127.0.0.1:3000`. It forces Streamable HTTP at `/mcp`, disables ngrok, and passes parsed credential values to Compose in memory. The generated configuration stores variable names, never their values. Each setup/update/rollback reads the original credential file again; its values, including quotes and dollar signs, are preserved. Adding a new variable name after setup also requires adding that variable reference to the generated Compose environment mapping. Setup prints the local HTTP client configuration. HTTP clients connect to this persistent service instead of spawning servers.

For a private controller CA, put an absolute host path in `OMADA_CA_FILE` and keep `OMADA_STRICT_SSL=true`. Fresh Docker setup validates the PEM bundle and mounts it read-only at `/certs/omada-ca.pem`. Existing Compose deployments must already mount the bundle and set `OMADA_CA_FILE` to its container path before adoption. Managed stdio uses the configured file path directly.

To adopt an existing running Compose service without restarting it:

```bash
omada-runtime setup docker \
  --compose-file /absolute/path/compose.yaml \
  --project omada-mcp --service omada-mcp \
  --url http://127.0.0.1:3000/mcp
```

Adoption records the running image's immutable registry digest and verifies its version through `getServerInfo`. It preserves the original Compose file, credentials, ports, restart settings, volumes and other services. The URL must point to the selected container's local Streamable HTTP endpoint. Use `update docker` after adoption to change versions.

The CLI writes `~/.omada-mcp/docker-override.json` with only the selected service's image. Manual Compose operations must include **both files** and the same project:

```bash
docker compose --project-name omada-mcp \
  -f /absolute/path/compose.yaml \
  -f ~/.omada-mcp/docker-override.json ps
```

Running the original Compose file alone can select its original image again. The CLI refuses updates if the running container differs from its saved image. To reconcile an externally changed deployment, adopt it using a new `--home` and its actual base Compose configuration.

Updates pull before changing the service, pin the resulting digest, recreate only that service (`--no-deps`), and verify the actual process with `getServerInfo`. Failed updates restore and verify the prior image. Rollback uses the saved prior digest from Docker's local image cache; keep that image until you no longer need rollback. Do not prune rollback images. The brief container replacement disconnects HTTP sessions; the CLI attempts to refresh registered clients afterward and reports any manual action needed.

If a public image pull fails due to stale registry login, the CLI retries anonymously with a temporary Docker configuration on the same daemon. It never changes your registry credentials or default context.

## Automatic client configuration and reconnecting

Setup supports Codex, Cursor and Claude Desktop. Codex registration uses `codex mcp add`, so the Codex CLI must be installed and available on `PATH`. Cursor and Claude Desktop configuration is edited with a JSON/JSONC parser that preserves unrelated properties and comments.

| Client         | stdio | Docker HTTP                | Refresh                                                                          |
| -------------- | ----- | -------------------------- | -------------------------------------------------------------------------------- |
| Codex          | Yes   | Yes                        | Request MCP reload through an existing app-server control socket, when available |
| Cursor         | Yes   | Yes                        | Reconnect in the client, or opt into a graceful app restart on macOS             |
| Claude Desktop | Yes   | No local HTTP registration | Reconnect in the client, or opt into a graceful app restart on macOS             |

To add clients to a runtime that is already set up, omit the original runtime setup flags:

```bash
omada-runtime setup docker --client codex cursor
omada-runtime setup stdio --client claude-desktop
omada-runtime reconnect docker
omada-runtime reconnect stdio
```

Codex refresh connects to the existing app-server control socket using a WebSocket HTTP Upgrade and framed JSON-RPC. It initializes that connection before calling `config/mcpServer/reload`. The default socket is `app-server-control/app-server-control.sock` under the registered Codex configuration directory. It does not launch another app-server or attach to an unrelated desktop IPC socket.

To select a known existing control socket explicitly:

```bash
omada-runtime reconnect docker --codex-socket /absolute/path/to/app-server-control.sock
```

`--codex-socket` also works on setup, update and rollback. It applies to that invocation only and is not saved in runtime or client configuration. Paths must be absolute filesystem paths; network URLs are rejected. A successful acknowledgment reports `reload-queued`, not verified tool availability. Check both the tool list and `getServerInfo` from the affected chat on a subsequent turn.

Failed Codex refresh results include `socketPath` and a bounded `reason`, such as `socket_missing`, `socket_unavailable`, `socket_forbidden`, `reload_rejected`, `protocol_error` or `timeout`. Some Desktop instances expose no public control socket; selecting another path cannot create one or transfer their loaded chats to another app-server. The runtime leaves those sessions running and reports `action-required`.

The runtime test suite includes real Unix WebSocket fixtures for initialization, acknowledgment, rejection, limits and cleanup. To additionally test an installed Codex binary in an isolated temporary profile, run `OMADA_TEST_CODEX_BINARY=/absolute/path/to/codex yarn test tests/runtime`. That acceptance test creates no chats and does not connect to the production Desktop app-server.

The stdio example requires an existing stdio setup; Docker and stdio selections are independent. Claude Desktop's local configuration accepts stdio servers. The CLI does not add an HTTP-to-stdio bridge or register a Docker URL in that file.

Setup adds only the `omada` server entry. Matching entries are retained, including extra client options. A different existing `omada` entry requires `--replace-client`. Before changing an existing file, setup creates an adjacent `.omada-<id>.bak` copy with private permissions. Invalid files, duplicate JSON properties and incompatible server collections are rejected without overwriting them. JSON configuration symlinks retain their target; Codex configuration symlinks require registration through Codex directly. `CODEX_HOME` selects the Codex profile. Keep backups private: they may contain other clients' secrets.

Selected clients and their configuration paths are saved in the runtime state. Update and rollback refresh them **after** the new runtime has passed verification. If settings have changed outside this CLI, refresh reports that and leaves them alone. Disabled entries stay disabled. A client refresh failure does not roll back a healthy runtime. If initial client registration fails, the runtime remains ready; retry `setup <mode> --client <name>` without installation flags.

`--restart-clients` on setup opts selected Cursor/Claude Desktop registrations into graceful restarts on later updates and rollbacks. On update, rollback or reconnect, the flag applies to that command only. It can close app windows, so save work first. An app that is already closed is left closed, and no process is force-killed. Repeating setup without the flag clears the saved restart preference. Codex is never quit or restarted by this option.

Refresh results distinguish `reload-queued`, `restart-requested`, `not-running` and `action-required`. Codex's reload acknowledgment means its existing app server queued a refresh for loaded chats; it does not prove a particular client's connection has changed. Many app sessions do not expose a control socket, in which case reconnect Omada through that client's MCP settings. After any refresh, call `getServerInfo` inside the client to verify its version and commit. `reconnect <mode>` retries refresh without installing or switching versions.

## State, errors and recovery

- Stdio and Docker selections coexist independently. `--home /absolute/path` changes the state directory for every command; use the same path consistently. State files use private permissions and contain paths and release identifiers, not credentials.
- Setup refuses to overwrite an existing runtime selection; `setup --client` can add client configuration to it. A directory lock prevents simultaneous changes. After an interrupted command, first verify no runtime command is still running before removing the reported `.runtime-lock` directory.
- Commands return exit code 0 on success and 1 on failure. Invalid options are rejected. Subprocess/controller errors are summarized without dumping private responses. Check the named dependency, local endpoint, credential file and network access, then rerun `doctor`.
- A failed recovery is reported explicitly. Inspect the saved state and override, restore Docker availability, and run Compose with both files followed by `doctor docker`. No success is reported unless the selected version responds through MCP.
- Use an exact `--version X.Y.Z` to pin releases. `latest` is resolved once during update; moving image tags and version ranges are never persisted. Releases before runtime archives were introduced can be adopted/rolled back in Docker but cannot be installed for managed stdio from a missing archive.
- The CLI does not rotate credentials, stop unrelated services, or manage the WAN guard. Desktop restarts require the explicit client option described above. Keep credential files and runtime state backups private.
