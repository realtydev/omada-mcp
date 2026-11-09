import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OperationCatalog } from '../../src/discovery/catalog.js';
import { prepareTransfer } from '../../src/discovery/transfer.js';

const path = '/openapi/v1/{omadacId}/sites/{siteId}/portal/pics';
const catalogue = new OperationCatalog(
    {
        openapi: '3.0.1',
        paths: {
            [path]: {
                post: {
                    operationId: 'upload',
                    requestBody: {
                        required: true,
                        content: {
                            'multipart/form-data': {
                                schema: {
                                    type: 'object',
                                    properties: { file: { type: 'string', format: 'binary' }, config: { type: 'object' } },
                                    required: ['file'],
                                },
                            },
                        },
                    },
                    responses: {},
                },
                get: {
                    operationId: 'download',
                    responses: { '200': { content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } } },
                },
            },
        },
    },
    'bundled'
);

describe('bounded operation file transfers', () => {
    it.skipIf(process.platform === 'win32')('rejects a FIFO without waiting for a writer', async () => {
        await promisify(execFile)('mkfifo', [join(root, 'pipe.pem')]);
        await expect(prepareTransfer(upload(), catalogue, { files: { file: 'pipe.pem' } }, { transferDirectory: root })).rejects.toThrow(
            'regular file'
        );
    });
    let root: string;
    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'omada-transfer-'));
        await writeFile(join(root, 'input.pem'), 'certificate-data');
    });
    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });
    const upload = () => catalogue.get('upload')!;
    const download = () => catalogue.get('download')!;
    it('previews upload names and sizes without request data or file contents', async () => {
        const plan = await prepareTransfer(upload(), catalogue, { files: { file: 'input.pem' }, body: { config: {} } }, { transferDirectory: root });
        expect(plan?.preview).toEqual({ upload: { files: [{ field: 'file', file: 'input.pem', bytes: 16 }], bytes: 16 } });
        expect(plan?.validationBody).toEqual({ file: 'input.pem', config: {} });
        expect(plan?.request?.data).toBeUndefined();
        expect(JSON.stringify(plan?.preview)).not.toContain('certificate-data');
    });
    it('builds native multipart only for explicit execution and preserves JSON fields', async () => {
        const plan = await prepareTransfer(
            upload(),
            catalogue,
            { files: { file: 'input.pem' }, body: { config: { enabled: false } }, dryRun: false },
            { transferDirectory: root }
        );
        expect(plan?.request?.data).toBeInstanceOf(FormData);
        const form = plan?.request?.data as FormData;
        expect(await (form.get('file') as Blob).text()).toBe('certificate-data');
        expect(await (form.get('config') as Blob).text()).toBe('{"enabled":false}');
        expect(plan?.request?.headers).toEqual({ 'Content-Type': 'multipart/form-data' });
    });
    it.each(['../input.pem', '/etc/passwd', '.env', 'sub/file', 'sub\\file', 'bad\nname'])('rejects unsafe file names %j', async (file) => {
        await expect(prepareTransfer(upload(), catalogue, { files: { file } }, { transferDirectory: root })).rejects.toThrow('basenames');
        await expect(prepareTransfer(download(), catalogue, { downloadFile: file }, { transferDirectory: root })).rejects.toThrow('basenames');
    });
    it('rejects missing configuration, symlinks, oversized files and undeclared file fields', async () => {
        await expect(prepareTransfer(upload(), catalogue, { files: { file: 'input.pem' } }, {})).rejects.toThrow('OMADA_TRANSFER_DIR');
        await symlink(join(root, 'input.pem'), join(root, 'link.pem'));
        await expect(prepareTransfer(upload(), catalogue, { files: { file: 'link.pem' } }, { transferDirectory: root })).rejects.toThrow();
        await expect(
            prepareTransfer(upload(), catalogue, { files: { file: 'input.pem' } }, { transferDirectory: root, maxTransferBytes: 2 })
        ).rejects.toThrow('size limit');
        await expect(prepareTransfer(upload(), catalogue, { files: { other: 'input.pem' } }, { transferDirectory: root })).rejects.toThrow(
            'not declared'
        );
    });
    it('saves a successful download exclusively with integrity metadata and private permissions', async () => {
        const plan = await prepareTransfer(download(), catalogue, { downloadFile: 'backup.bin' }, { transferDirectory: root });
        expect(plan?.request?.responseType).toBe('arraybuffer');
        await expect(stat(join(root, 'backup.bin'))).rejects.toThrow();
        const result = await plan!.finalize!(Buffer.from([0, 1, 2, 3]));
        expect(result).toMatchObject({ file: 'backup.bin', bytes: 4, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(await readFile(join(root, 'backup.bin'))).toEqual(Buffer.from([0, 1, 2, 3]));
        expect((await stat(join(root, 'backup.bin'))).mode & 0o777).toBe(0o600);
        await expect(prepareTransfer(download(), catalogue, { downloadFile: 'backup.bin' }, { transferDirectory: root })).rejects.toThrow(
            'already exists'
        );
    });
    it('never overwrites a target created after preparation', async () => {
        const plan = await prepareTransfer(download(), catalogue, { downloadFile: 'race.bin' }, { transferDirectory: root });
        await writeFile(join(root, 'race.bin'), 'preserve');
        await expect(plan!.finalize!(Buffer.from('new'))).rejects.toThrow();
        expect(await readFile(join(root, 'race.bin'), 'utf8')).toBe('preserve');
    });
    it('rejects replacement of the transfer directory before saving a response', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'omada-outside-'));
        const oldRoot = `${root}-old`;
        try {
            const plan = await prepareTransfer(download(), catalogue, { downloadFile: 'result.bin' }, { transferDirectory: root });
            await rename(root, oldRoot);
            await symlink(outside, root);
            await expect(plan!.finalize!(Buffer.from('private-data'))).rejects.toThrow('directory changed');
            await expect(stat(join(outside, 'result.bin'))).rejects.toThrow();
        } finally {
            await rm(root, { force: true });
            await rename(oldRoot, root);
            await rm(outside, { recursive: true, force: true });
        }
    });
    it.each([Buffer.from('<html>login</html>'), Buffer.from('{"errorCode":-1,"msg":"Forbidden"}'), Buffer.alloc(0)])(
        'rejects unsuccessful file responses without creating a file',
        async (response) => {
            const plan = await prepareTransfer(download(), catalogue, { downloadFile: 'result.bin' }, { transferDirectory: root });
            await expect(plan!.finalize!(response)).rejects.toThrow();
            await expect(stat(join(root, 'result.bin'))).rejects.toThrow();
        }
    );
    it('rejects oversized downloads and unsupported transfer use', async () => {
        const plan = await prepareTransfer(download(), catalogue, { downloadFile: 'result.bin' }, { transferDirectory: root, maxTransferBytes: 2 });
        await expect(plan!.finalize!(Buffer.from([1, 2, 3]))).rejects.toThrow('size limit');
        await expect(prepareTransfer(upload(), catalogue, { downloadFile: 'result.bin' }, { transferDirectory: root })).rejects.toThrow('GET');
        await expect(prepareTransfer(download(), catalogue, { files: { file: 'input.pem' } }, { transferDirectory: root })).rejects.toThrow(
            'does not accept'
        );
    });
});
