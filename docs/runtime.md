# Runtime CLI

`omada-runtime` manages exact releases of the existing MCP server. Node 24+ is required. Docker mode additionally requires Docker Engine and Docker Compose v2. The CLI uses the current Docker context or `DOCKER_HOST`.

## Install

Install the runtime archive attached to the desired [GitHub release](https://github.com/realtydev/omada-mcp/releases). For example, replace `X.Y.Z` with that release's version:

```bash
npm install -g --ignore-scripts https://github.com/realtydev/omada-mcp/releases/download/vX.Y.Z/realtydev-omada-mcp-X.Y.Z.tgz
omada-runtime --help
```

Archives include the compiled server and both `omada-mcp` and `omada-runtime` executables. No npm registry publication is required. You can download the archive and `SHA256SUMS` from the same release to check its checksum before installing. Source checkouts can use `yarn build` then `node dist/runtime.js` instead.

## Client-managed stdio

Create a credential file using the controller variables documented in the README. Restrict its permissions (`chmod 600 /absolute/path/omada.env`). The CLI references the file without editing, copying or printing its contents. It loads this one file; combine `.env` and `.env.local` settings into that file if both are needed. Environment values in the selected file take precedence over inherited values for managed stdio.

```bash
omada-runtime setup stdio --env-file /absolute/path/omada.env --version X.Y.Z
omada-runtime doctor stdio
omada-runtime status stdio
omada-runtime update stdio --version X.Y.Z
omada-runtime update stdio --version latest
omada-runtime rollback stdio
```

Setup prints MCP client JSON with your absolute Node path and a stable `~/.omada-mcp/stdio.mjs` launcher. Copy it into your client's MCP settings. Each client launches its own server subprocess. There is no background stdio service. The launcher follows the selected version on the next connection.

`status` starts a fresh subprocess and verifies its `getServerInfo`. It cannot inspect an already-connected client's subprocess. After every update or rollback, reconnect the client and call `getServerInfo` **inside that client** to compare its version and commit. `doctor` additionally calls the read-only `listSites` tool to verify controller access. Neither command changes controller settings.

Versions are installed under `~/.omada-mcp/versions/`. Update verifies the candidate before changing the selection. Rollback switches to the last successful selection and verifies it first. Existing processes keep running their previous build until reconnected. `--package /path/to/release.tgz` lets stdio setup/update install a local archive whose embedded version must match `--version`; dependencies still need to be available from npm/cache.

## Persistent local Docker service

For a new service:

```bash
omada-runtime setup docker --env-file /absolute/path/omada.env --version X.Y.Z --port 3000
omada-runtime doctor docker
omada-runtime status docker
omada-runtime update docker --version X.Y.Z
omada-runtime rollback docker
```

The generated Compose service restarts with Docker (`unless-stopped`) and publishes only `127.0.0.1:3000`. It forces Streamable HTTP at `/mcp`, disables ngrok, and passes parsed credential values to Compose in memory. The generated configuration stores variable names, never their values. Each setup/update/rollback reads the original credential file again; its values, including quotes and dollar signs, are preserved. Adding a new variable name after setup also requires adding that variable reference to the generated Compose environment mapping. Setup prints the local HTTP client configuration. HTTP clients connect to this persistent service instead of spawning servers.

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

Updates pull before changing the service, pin the resulting digest, recreate only that service (`--no-deps`), and verify the actual process with `getServerInfo`. Failed updates restore and verify the prior image. Rollback uses the saved prior digest from Docker's local image cache; keep that image until you no longer need rollback. Do not prune rollback images. The brief container replacement disconnects HTTP sessions; reconnect clients afterward.

If a public image pull fails due to stale registry login, the CLI retries anonymously with a temporary Docker configuration on the same daemon. It never changes your registry credentials or default context.

## State, errors and recovery

- Stdio and Docker selections coexist independently. `--home /absolute/path` changes the state directory for every command; use the same path consistently. State files use private permissions and contain paths and release identifiers, not credentials.
- Setup refuses to overwrite an existing selection. A directory lock prevents simultaneous changes. After an interrupted command, first verify no runtime command is still running before removing the reported `.runtime-lock` directory.
- Commands return exit code 0 on success and 1 on failure. Invalid options are rejected. Subprocess/controller errors are summarized without dumping private responses. Check the named dependency, local endpoint, credential file and network access, then rerun `doctor`.
- A failed recovery is reported explicitly. Inspect the saved state and override, restore Docker availability, and run Compose with both files followed by `doctor docker`. No success is reported unless the selected version responds through MCP.
- Use an exact `--version X.Y.Z` to pin releases. `latest` is resolved once during update; moving image tags and version ranges are never persisted. Releases before runtime archives were introduced can be adopted/rolled back in Docker but cannot be installed for managed stdio from a missing archive.
- The CLI does not edit MCP client settings, rotate credentials, stop unrelated services, or manage the WAN guard. Keep credential files and runtime state backups private.
