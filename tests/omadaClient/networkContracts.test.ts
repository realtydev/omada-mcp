import { describe, expect, it, vi } from 'vitest';
import type { InternalRequestHandler } from '../../src/omadaClient/internalRequest.js';
import { NetworkOperations } from '../../src/omadaClient/network.js';
import type { RequestHandler } from '../../src/omadaClient/request.js';
import type { SiteOperations } from '../../src/omadaClient/site.js';

function setup() {
    const request = {
        get: vi.fn(),
        post: vi.fn().mockResolvedValue({ errorCode: 0, result: { id: 'acl-id' } }),
        put: vi.fn().mockResolvedValue({ errorCode: 0, result: {} }),
        delete: vi.fn().mockResolvedValue({ errorCode: 0, result: {} }),
        request: vi.fn().mockResolvedValue({ errorCode: 0, result: {} }),
        fetchPaginated: vi.fn().mockResolvedValue([]),
        ensureSuccess: vi.fn((response) => response.result),
    };
    const site = { resolveSiteId: () => 'site/id' };
    const operations = new NetworkOperations(
        request as unknown as RequestHandler,
        site as unknown as SiteOperations,
        (path, version = 'v1') => `/openapi/${version}/controller${path}`
    );
    return { request, operations };
}

describe('network Open API write contracts', () => {
    it('patches LAN profiles rather than using the unsupported PUT method', async () => {
        const { request, operations } = setup();
        await operations.updateLanProfile('profile/id', { name: 'new name' });
        expect(request.request).toHaveBeenCalledWith({
            method: 'PATCH',
            url: '/openapi/v1/controller/sites/site%2Fid/lan-profiles/profile%2Fid',
            data: { name: 'new name' },
        });
        expect(request.put).not.toHaveBeenCalled();
    });

    it('uses the gateway ACL collection and its distinct update/delete resources', async () => {
        const { request, operations } = setup();
        const collection = '/openapi/v1/controller/sites/site%2Fid/acls/osg-acls';
        await operations.listFirewallAcls();
        await operations.createFirewallAcl({ name: 'test rule' });
        await operations.updateFirewallAcl('acl/id', { status: false });
        await operations.deleteFirewallAcl('acl/id');
        expect(request.fetchPaginated).toHaveBeenCalledWith(collection);
        expect(request.post).toHaveBeenCalledWith(collection, { name: 'test rule' });
        expect(request.put).toHaveBeenCalledWith(`${collection}/acl%2Fid`, { status: false });
        expect(request.delete).toHaveBeenCalledWith('/openapi/v1/controller/sites/site%2Fid/acls/acl%2Fid');
    });

    it('preserves the web API routes when web credentials are configured', async () => {
        const { request, operations } = setup();
        const internal = setup().request;
        internal.get.mockResolvedValue({ errorCode: 0, result: [] });
        operations.setInternalRequest(internal as unknown as InternalRequestHandler);
        const collection = '/sites/site%2Fid/setting/firewall/acls';
        await operations.listFirewallAcls();
        await operations.createFirewallAcl({ name: 'test rule' });
        await operations.updateFirewallAcl('acl/id', { status: false });
        await operations.deleteFirewallAcl('acl/id');
        expect(internal.get).toHaveBeenCalledWith(collection, { type: 0, currentPage: 1, currentPageSize: 100 });
        expect(internal.post).toHaveBeenCalledWith(collection, { name: 'test rule' });
        expect(internal.put).toHaveBeenCalledWith(`${collection}/acl%2Fid`, { status: false });
        expect(internal.delete).toHaveBeenCalledWith(`${collection}/acl%2Fid`);
        expect(request.fetchPaginated).not.toHaveBeenCalled();
        expect(request.post).not.toHaveBeenCalled();
        expect(request.put).not.toHaveBeenCalled();
        expect(request.delete).not.toHaveBeenCalled();
    });
});
