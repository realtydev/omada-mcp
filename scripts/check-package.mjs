// Exercise the shipped archive and both executable links without contacting a controller.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { atomicJson, installStdio, probe, statePath, writeLauncher } from '../dist/runtime/core.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'omada-package-'));
const execute = promisify(execFile);
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
try {
    const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const packed = await execute('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, env });
    const archive = join(temporary, JSON.parse(packed.stdout)[0].filename);
    const home = join(temporary, 'runtime');
    const selection = await installStdio(home, metadata.version, archive);
    const credentials = join(temporary, 'test.env');
    await writeFile(
        credentials,
        'OMADA_BASE_URL=https://controller.example.com\nOMADA_OMADAC_ID=test-controller\nOMADA_CLIENT_ID=test-client\nOMADA_CLIENT_SECRET=test-secret\nMCP_SERVER_USE_HTTP=true\n',
        { mode: 0o600 }
    );
    const state = { mode: 'stdio', current: selection, envFile: credentials };
    const info = await probe(state);
    assert.equal(info.packageVersion, metadata.version);
    await assert.rejects(probe(state, { ...selection, gitCommit: '0'.repeat(40) }), /Cannot verify/);
    await atomicJson(statePath(home, 'stdio'), state);
    const launcher = await writeLauncher(home);
    // A hostile cwd dotenv must not turn the stdio launcher into an HTTP server.
    await writeFile(join(home, '.env.local'), 'MCP_SERVER_USE_HTTP=true\nOMADA_CLIENT_SECRET=wrong\n');
    const client = new Client({ name: 'package-check', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [launcher], cwd: home, stderr: 'pipe' });
    transport.stderr.on('data', () => undefined);
    try {
        await client.connect(transport, { timeout: 8000 });
        const response = await client.callTool({ name: 'getServerInfo', arguments: {} });
        assert.notEqual(response.isError, true);
        assert.equal(JSON.parse(response.content[0].text).packageVersion, metadata.version);
    } finally {
        await client.close();
    }
    for (const bin of ['omada-mcp', 'omada-runtime']) {
        const path = join(home, 'versions', metadata.version, 'node_modules/.bin', bin);
        assert.ok((await readFile(path, 'utf8')).startsWith('#!/usr/bin/env node'));
    }
    const help = await execute(join(home, 'versions', metadata.version, 'node_modules/.bin/omada-runtime'), ['--help'], { env });
    assert.match(help.stdout, /setup stdio/);
    const dockerHelp = await execute(join(home, 'versions', metadata.version, 'node_modules/.bin/omada-runtime'), ['setup', 'docker', '--help'], {
        env,
    });
    assert.match(dockerHelp.stdout, /--compose-file/);
    const direct = new Client({ name: 'bin-check', version: '1.0.0' });
    const directTransport = new StdioClientTransport({
        command: join(home, 'versions', metadata.version, 'node_modules/.bin/omada-mcp'),
        cwd: temporary,
        env: { ...env, OMADA_ENV_FILE: credentials, MCP_SERVER_USE_HTTP: 'false' },
        stderr: 'pipe',
    });
    directTransport.stderr.on('data', () => undefined);
    try {
        await direct.connect(directTransport, { timeout: 8000 });
        assert.ok(await direct.callTool({ name: 'getServerInfo', arguments: {} }));
    } finally {
        await direct.close();
    }
    process.stdout.write(
        `Package archive, executable bins, getServerInfo and stable stdio launcher passed (${info.packageVersion}/${info.gitCommit}).\n`
    );
} finally {
    await rm(temporary, { recursive: true, force: true });
}
