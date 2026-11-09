import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import https from 'node:https';
import { getCACertificates } from 'node:tls';

import type { AxiosRequestConfig } from 'axios';

import type { EnvironmentConfig } from '../config.js';

type ControllerHttpOptions = Pick<EnvironmentConfig, 'baseUrl' | 'strictSsl' | 'caFile' | 'requestTimeout'>;

function loadCaCertificates(filePath: string): string[] {
    let pem: string;
    try {
        pem = readFileSync(filePath, 'utf8');
    } catch {
        throw new Error(`Unable to read OMADA_CA_FILE: ${filePath}`);
    }

    const certificatePattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certificates = pem.match(certificatePattern);
    try {
        if (!certificates?.length || pem.replace(certificatePattern, '').trim()) {
            throw new Error('Invalid PEM bundle');
        }
        for (const certificate of certificates) {
            new X509Certificate(certificate);
        }
    } catch {
        throw new Error('OMADA_CA_FILE must contain only valid PEM certificates');
    }
    return certificates;
}

/** Configure the single transport shared by controller authentication and API requests. */
export function createControllerHttpOptions(options: ControllerHttpOptions): AxiosRequestConfig {
    if (options.caFile !== undefined && (!options.caFile.trim() || !options.strictSsl)) {
        throw new Error('OMADA_CA_FILE requires a non-empty path and OMADA_STRICT_SSL=true');
    }
    const ca = options.caFile ? [...getCACertificates('default'), ...loadCaCertificates(options.caFile)] : undefined;

    return {
        baseURL: options.baseUrl,
        // Preserve Node's default trust and hostname verification when adding a private CA.
        httpsAgent: new https.Agent({ rejectUnauthorized: options.strictSsl, ...(ca ? { ca } : {}) }),
        // Never forward controller credentials or write requests to a redirected URL.
        maxRedirects: 0,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        ...(options.requestTimeout ? { timeout: options.requestTimeout } : {}),
    };
}
