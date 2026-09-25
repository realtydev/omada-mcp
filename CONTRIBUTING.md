# Contributing

Thanks for helping make Omada MCP better. Bug reports, endpoint fixes, and new tools are all welcome.

## Setup

Requires Node 24 (`nvm use`) and Yarn 4 via Corepack.

```bash
corepack enable
yarn install
cp .env.example .env   # fill in your controller details
yarn dev               # run from source with tsx
```

## Before you open a PR

```bash
yarn lint:fix   # Biome format + lint
yarn check      # lint + tsc --noEmit
yarn test       # vitest
```

CI runs the same checks and enforces coverage thresholds.

## Adding a tool

1. Add the client method in `src/omadaClient/<area>.ts` and expose it on `OmadaClient` in `src/omadaClient/index.ts`.
2. Add `src/tools/<toolName>.ts` with a Zod input schema. Write tools use `.strict()` and set `annotations: { destructiveHint: true }`.
3. Register it in `src/tools/index.ts` and add it to the list in `tests/tools/index.test.ts`.
4. Add tests for the client method (the exact path and payload) and for the tool.
5. Add a row to the tool tables in `README.md`.

Endpoint paths and payloads should match the bundled Open API spec in `docs/openapi/`. For internal web UI endpoints, note in the PR how you verified the path, for example from a network capture of the controller UI.

## Commits and PRs

- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:` …).
- Keep PRs focused on one behavior, with tests and docs in the same PR.
- If you tested against a live controller, say which model and firmware.
- Never include real MAC addresses, public IPs, credentials, or controller IDs in tests or docs. Use `AA-BB-CC-DD-EE-FF` and the `192.0.2.0/24` / `203.0.113.0/24` documentation ranges.

## Releasing (maintainers)

1. Move the `Unreleased` notes in `CHANGELOG.md` under a new version heading and bump `version` in `package.json`.
2. Merge to `main`, then tag: `git tag v0.7.0 && git push origin v0.7.0`.
3. The Release workflow publishes `ghcr.io/realtydev/omada-mcp:{version}` and `:latest`, then creates the GitHub release from the changelog.
