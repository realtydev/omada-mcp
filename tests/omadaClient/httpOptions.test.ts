import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkServerIdentity, getCACertificates, rootCertificates } from 'node:tls';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createControllerHttpOptions } from '../../src/omadaClient/httpOptions.js';
import { OmadaClient } from '../../src/omadaClient/index.js';

const options = { baseUrl: 'https://controller.example.com', strictSsl: true, requestTimeout: 5000 };

describe('controller HTTP options', () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), 'omada-http-options-'));
    });

    afterEach(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('keeps strict verification, JSON headers, timeout and disables redirects by default', () => {
        const config = createControllerHttpOptions(options);
        expect(config).toMatchObject({
            baseURL: options.baseUrl,
            maxRedirects: 0,
            timeout: 5000,
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        });
        expect(config.httpsAgent).toBeInstanceOf(Agent);
        expect(config.httpsAgent.options.rejectUnauthorized).toBe(true);
        expect(config.httpsAgent.options.ca).toBeUndefined();
        expect(config.httpsAgent.options.checkServerIdentity).toBeUndefined();
    });

    it('preserves the explicit insecure option when no private CA is set', () => {
        const config = createControllerHttpOptions({ ...options, strictSsl: false, requestTimeout: undefined });
        expect(config.httpsAgent.options.rejectUnauthorized).toBe(false);
        expect(config).not.toHaveProperty('timeout');
    });

    it('appends every certificate in a PEM bundle to all default trusted certificates', () => {
        const file = join(directory, 'ca.pem');
        writeFileSync(file, `${rootCertificates[0]}\n${rootCertificates[1]}\n`);

        const config = createControllerHttpOptions({ ...options, caFile: file });

        expect(config.httpsAgent.options.ca).toEqual([...getCACertificates('default'), rootCertificates[0], rootCertificates[1]]);
        expect(config.httpsAgent.options.rejectUnauthorized).toBe(true);
        // An absent override retains Node's hostname check, which rejects unrelated names.
        expect(config.httpsAgent.options.checkServerIdentity).toBeUndefined();
        const certificate = new X509Certificate(rootCertificates[0]).toLegacyObject();
        expect(checkServerIdentity('controller.example.com', certificate)?.message).toContain('Hostname/IP does not match');
    });

    it('fails synchronously for missing files and directories', () => {
        for (const file of [join(directory, 'missing.pem'), directory]) {
            expect(() => createControllerHttpOptions({ ...options, caFile: file })).toThrow('Unable to read OMADA_CA_FILE');
        }
    });

    it.each(['', '  ', 'private-certificate-content', '-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----'])(
        'rejects empty or malformed certificate files without exposing their contents (%#)',
        (pem) => {
            const file = join(directory, 'ca.pem');
            writeFileSync(file, pem);
            expect(() => createControllerHttpOptions({ ...options, caFile: file })).toThrow('OMADA_CA_FILE must contain only valid PEM certificates');
        }
    );

    it('rejects bundles containing an invalid second certificate or unrelated content', () => {
        const file = join(directory, 'ca.pem');
        for (const suffix of ['\n-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----', '\nprivate-key-content']) {
            writeFileSync(file, `${rootCertificates[0]}${suffix}`);
            expect(() => createControllerHttpOptions({ ...options, caFile: file })).toThrow('OMADA_CA_FILE must contain only valid PEM certificates');
        }
    });

    it('also validates direct client configurations before any network work', () => {
        for (const configuration of [
            { ...options, caFile: ' ' },
            { ...options, caFile: '/certs/ca.pem', strictSsl: false },
        ]) {
            expect(() => createControllerHttpOptions(configuration)).toThrow('OMADA_CA_FILE requires a non-empty path and OMADA_STRICT_SSL=true');
        }
        expect(
            () =>
                new OmadaClient({
                    ...options,
                    caFile: join(directory, 'missing.pem'),
                    authMode: 'oauth',
                    omadacId: 'controller',
                    logLevel: 'info',
                    logFormat: 'plain',
                    useHttp: false,
                    stateful: false,
                    httpTransport: 'stream',
                    httpEnableHealthcheck: true,
                    httpAllowCors: true,
                    httpNgrokEnabled: false,
                })
        ).toThrow('Unable to read OMADA_CA_FILE');
    });
});
