import { randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { applyEdits, findNodeAtLocation, getNodeValue, type Node as JsonNode, modify, type ParseError, parseTree } from 'jsonc-parser';
import { type ClientRefreshOptions, type RefreshResult, refreshClient } from './clientRefresh.js';
import { atomicJson, atomicText, localUrl, type Runner, type RuntimeState, run, statePath, withLock, writeLauncher } from './core.js';

export const CLIENTS = ['codex', 'cursor', 'claude-desktop'] as const;
export type ManagedClient = (typeof CLIENTS)[number];
export interface ClientRegistration {
    client: ManagedClient;
    configPath: string;
    restartOnUpdate: boolean;
}
export interface ClientSetupOptions extends ClientRefreshOptions {
    replace?: boolean;
    // Tests and callers with a known client profile may supply its native configuration path.
    configPath?: string;
}
export interface ClientSetupResult {
    client: ManagedClient;
    configPath: string;
    changed: boolean;
    backupPath?: string;
    refresh: RefreshResult;
}
type Entry = Record<string, unknown>;
const isObject = (value: unknown): value is Entry => typeof value === 'object' && value !== null && !Array.isArray(value);

export function validateClientMode(client: ManagedClient, mode: RuntimeState['mode']): void {
    if (mode === 'docker' && client === 'claude-desktop') {
        throw new Error(
            `${client} local configuration requires stdio. Use setup stdio --client ${client}; Docker HTTP setup is supported by Codex and Cursor.`
        );
    }
}
export function clientPath(client: ManagedClient): string {
    if (client === 'codex') return join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
    if (client === 'cursor') return join(homedir(), '.cursor', 'mcp.json');
    const directory =
        process.platform === 'darwin'
            ? join(homedir(), 'Library', 'Application Support')
            : process.platform === 'win32'
              ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
              : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
    return join(directory, 'Claude', 'claude_desktop_config.json');
}
export async function clientEntry(home: string, state: RuntimeState, client: ManagedClient): Promise<Entry> {
    validateClientMode(client, state.mode);
    if (state.mode === 'docker') {
        return { ...(client === 'cursor' ? { type: 'http' } : {}), url: localUrl(state.url ?? '') };
    }
    return { command: process.execPath, args: [await writeLauncher(home)], ...(client === 'cursor' ? { type: 'stdio' } : {}) };
}
function matches(existing: unknown, desired: Entry): boolean {
    return (
        isObject(existing) &&
        Object.entries(desired).every(
            ([key, value]) => (key === 'type' && existing[key] === undefined) || JSON.stringify(existing[key]) === JSON.stringify(value)
        )
    );
}
function assertUniqueKeys(node: JsonNode): void {
    if (node.type === 'object') {
        const names = node.children?.map((property) => property.children?.[0]?.value) ?? [];
        if (new Set(names).size !== names.length)
            throw new Error('Client configuration contains duplicate properties. Resolve them before automatic setup.');
    }
    for (const child of node.children ?? []) assertUniqueKeys(child);
}
function parseClientJson(text: string): JsonNode {
    const errors: ParseError[] = [];
    const tree = parseTree(text, errors, { allowTrailingComma: true });
    if (!tree || errors.length || tree.type !== 'object') throw new Error('Client configuration is not a valid JSON object. It was left unchanged.');
    assertUniqueKeys(tree);
    return tree;
}
async function readOptional(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if (isObject(error) && error.code === 'ENOENT') return undefined;
        throw new Error('Cannot read the client configuration. Check its file permissions.');
    }
}
async function backup(path: string, text: string | undefined): Promise<string | undefined> {
    if (text === undefined) return undefined;
    const destination = `${path}.omada-${randomUUID()}.bak`;
    await writeFile(destination, text, { mode: 0o600, flag: 'wx' });
    return destination;
}
async function codexEntry(execute: Runner, configPath: string): Promise<unknown> {
    const output = await execute('codex', ['mcp', 'list', '--json'], undefined, { CODEX_HOME: dirname(configPath) });
    const entries = JSON.parse(output) as unknown;
    if (!Array.isArray(entries)) throw new Error('Codex returned an invalid MCP configuration list. No client settings were changed.');
    const entry = entries.find((value: unknown) => isObject(value) && value.name === 'omada') as Entry | undefined;
    return entry && isObject(entry.transport) ? { ...entry.transport, enabled: entry.enabled } : undefined;
}
function disabled(existing: unknown): boolean {
    return isObject(existing) && (existing.enabled === false || existing.disabled === true);
}
function disabledResult(client: ManagedClient): RefreshResult {
    return {
        client,
        status: 'action-required',
        message: 'Omada is disabled in the client configuration. Enable it in the client before reconnecting.',
    };
}
function codexMatches(existing: unknown, desired: Entry): boolean {
    if (!isObject(existing)) return false;
    if (desired.url) return existing.type === 'streamable_http' && existing.url === desired.url;
    return existing.type === 'stdio' && matches(existing, desired);
}

export async function configureClient(
    home: string,
    state: RuntimeState,
    client: ManagedClient,
    options: ClientSetupOptions = {},
    execute: Runner = run
): Promise<ClientSetupResult> {
    const desired = await clientEntry(home, state, client);
    let path = options.configPath ?? clientPath(client);
    try {
        const info = await lstat(path);
        if (client === 'codex' && info.isSymbolicLink())
            throw new Error('Codex configuration is a symlink. Configure it with the Codex CLI directly to preserve that link.');
        path = await realpath(path);
    } catch (error) {
        if (!(isObject(error) && error.code === 'ENOENT')) throw error;
    }
    const result = await withLock(
        dirname(path),
        async () => {
            const original = await readOptional(path);
            let existing: unknown;
            let next: string | undefined;
            if (client === 'codex') {
                existing = await codexEntry(execute, path);
                if (codexMatches(existing, desired)) return { changed: false, disabled: disabled(existing) };
            } else {
                const text = original ?? '{}\n';
                const tree = parseClientJson(text);
                const root = 'mcpServers';
                const servers = findNodeAtLocation(tree, [root]);
                if (servers && servers.type !== 'object') throw new Error('The client server collection is not an object. It was left unchanged.');
                const node = findNodeAtLocation(tree, [root, 'omada']);
                existing = node ? getNodeValue(node) : undefined;
                if (matches(existing, desired)) return { changed: false, disabled: disabled(existing) };
                next = applyEdits(
                    text,
                    modify(text, [root, 'omada'], desired, {
                        formattingOptions: { insertSpaces: !/^\t/m.test(text), tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' },
                    })
                );
                parseClientJson(next);
            }
            if (existing !== undefined && !options.replace)
                throw new Error(
                    `${client} already has a different omada entry. Use --replace-client to replace only that entry after saving a private backup.`
                );
            const backupPath = await backup(path, original);
            if ((await readOptional(path)) !== original)
                throw new Error('Client configuration changed during setup. Retry; no client settings were written.');
            if (client === 'codex') {
                const args = desired.url
                    ? ['mcp', 'add', 'omada', '--url', String(desired.url)]
                    : ['mcp', 'add', 'omada', '--', String(desired.command), ...(desired.args as string[])];
                try {
                    await execute('codex', args, undefined, { CODEX_HOME: dirname(path) });
                } catch {
                    throw new Error(
                        `Codex registration failed. Runtime setup is preserved${backupPath ? `; the original client configuration is backed up at ${backupPath}` : ''}.`
                    );
                }
                if (!codexMatches(await codexEntry(execute, path), desired))
                    throw new Error('Codex did not save the requested Omada entry. Inspect its private backup before retrying.');
            } else if (next !== undefined) await atomicText(path, next);
            return { changed: true, backupPath };
        },
        '.omada-runtime-client-lock'
    );
    const registration: ClientRegistration = { client, configPath: path, restartOnUpdate: options.restart ?? false };
    const clients = [...(state.clients ?? []).filter((item) => item.client !== client), registration];
    await atomicJson(statePath(home, state.mode), { ...state, clients });
    state.clients = clients;
    const { disabled: isDisabled, ...change } = result;
    return {
        client,
        configPath: path,
        ...change,
        refresh: isDisabled ? disabledResult(client) : await refreshClient(registration, execute, options.codexSocketPath),
    };
}

export async function refreshClients(
    home: string,
    state: RuntimeState,
    options: ClientRefreshOptions = {},
    execute: Runner = run
): Promise<RefreshResult[]> {
    const results: RefreshResult[] = [];
    for (const registration of state.clients ?? []) {
        try {
            const desired = await clientEntry(home, state, registration.client);
            const text = await readOptional(registration.configPath);
            const existing =
                registration.client === 'codex'
                    ? await codexEntry(execute, registration.configPath)
                    : getNodeValue(
                          findNodeAtLocation(parseClientJson(text ?? ''), ['mcpServers', 'omada']) ?? { type: 'null', offset: 0, length: 0 }
                      );
            if (!(registration.client === 'codex' ? codexMatches(existing, desired) : matches(existing, desired))) {
                results.push({
                    client: registration.client,
                    status: 'action-required',
                    message: 'Client configuration changed outside this runtime. Run setup with --client again before reconnecting.',
                });
                continue;
            }
            results.push(
                disabled(existing)
                    ? disabledResult(registration.client)
                    : await refreshClient(
                          { ...registration, restartOnUpdate: options.restart || registration.restartOnUpdate },
                          execute,
                          options.codexSocketPath
                      )
            );
        } catch {
            results.push({
                client: registration.client,
                status: 'action-required',
                message:
                    'Runtime is ready, but client refresh could not be completed. Check the client configuration and reconnect Omada in the client.',
            });
        }
    }
    return results;
}
