# Omada MCP contributor automation

Read `CONTRIBUTING.md` before changing code. It defines setup, required checks, tool additions, endpoint verification, and release procedure. Use `package.json`, `.nvmrc`, `tsconfig.json`, and `biome.json` for current tooling versions and options.

## Workload coordination

Before local type checks, builds, or servers, read `/Users/alex/.config/agent-workload/README.md` when available. Run finite checks through `/Users/alex/.local/bin/agent-workload check -- <command>` on this shared Mac. Reuse matching servers and preserve other owners' processes. CI and machines without that local guard use the normal package scripts.

## Change workflow

1. Branch from current `main` and target `main` in pull requests. Keep unrelated fixes in separate commits.
2. Trace the public tool through `src/tools/`, the `OmadaClient` facade, and the responsible `src/omadaClient/` operation module before editing.
3. Verify API paths, HTTP methods, parameters, and response shapes against the relevant per-tag file in `docs/openapi/`. The bundled snapshot may lag new firmware; record an authoritative source or sanitized live capture for newer endpoints. Keep the reference JSON unchanged.
4. Add regression tests under `tests/` for the responsible client and tool layers. Exercise protocol behavior when schemas or annotations change. Mock controller calls unless live testing was explicitly requested.
5. Update both `README.md` and `README.Docker.md` for tool or configuration changes and add an entry under `CHANGELOG.md` Unreleased.
6. Run `yarn check`, `yarn test:coverage`, `yarn audit`, and `yarn build`. Report actual results and any live controller model/firmware tested.

## API and transport conventions

- Prefer documented Open API endpoints. Reuse `RequestHandler` authentication, retries, success checks, and pagination instead of issuing raw requests from tools.
- OAuth client credentials are the default. Fusion gateways also support `OMADA_AUTH_MODE=web`; internal web UI endpoints use the existing web-session helpers. Keep auth-mode compatibility when changing shared requests.
- Use `fetchPaginated` for operations that return all records. For explicit page-based tools, reuse `createPaginationSchema` from `src/utils/pagination-schema.ts`.
- Pass the complete `.strict()` Zod object to `registerTool` for writes; passing only `.shape` loses strictness. Mark writes `destructiveHint: true` and read-only tools `readOnlyHint: true`.
- Keep HTTP behavior consistent across SSE and Streamable HTTP. Preserve origin checks, localhost defaults, and session cleanup.
- Expose controller errors rather than converting unsupported features into successful empty results.

## Configuration and sensitive data

- Load and validate environment configuration in `src/config.ts` and `src/utils/config-validations.ts`; pass validated values to operations.
- Use the logger in `src/utils/logger.ts`. Preserve credential, token, cookie, and payload redaction.
- Use synthetic identifiers and documentation IP ranges in fixtures and docs. Keep `.env` files and live controller responses containing secrets out of commits.
- Keep TypeScript types precise; use `unknown` for firmware-dependent payloads rather than inventing a schema.
- Use Yarn through Corepack. Keep Node types aligned with the supported runtime; review runtime major upgrades deliberately.
