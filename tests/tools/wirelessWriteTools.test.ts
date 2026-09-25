import { describe, expect, it, vi } from 'vitest';

describe('Wireless Write Tools', () => {
    describe('registerSetSsidEnableTool', () => {
        it('should register the tool and pass ssidId and enable through to the client', async () => {
            const { registerSetSsidEnableTool } = await import('../../src/tools/setSsidEnable.js');

            const mockClient = { setSsidEnable: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ siteId: 'test-site', ssidId: 'ssid-1', enable: false }, {})),
            };

            registerSetSsidEnableTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'setSsidEnable',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.setSsidEnable).toHaveBeenCalledWith('ssid-1', false, 'test-site');
        });
    });

    describe('registerUpdateSsidTool', () => {
        it('should register the tool and pass wlanId, ssidId, and ssid config through to the client', async () => {
            const { registerUpdateSsidTool } = await import('../../src/tools/updateSsid.js');

            const ssid = { name: 'Corporate WiFi', band: 3, security: 'wpa2-psk' };
            const mockClient = { updateSsid: vi.fn().mockResolvedValue({}) };
            const mockServer = {
                registerTool: vi.fn((_, _schema, handler) => handler({ wlanId: 'wlan-1', ssidId: 'ssid-1', siteId: 'test-site', ssid }, {})),
            };

            registerUpdateSsidTool(mockServer as never, mockClient as never);

            expect(mockServer.registerTool).toHaveBeenCalledWith(
                'updateSsid',
                expect.objectContaining({ description: expect.any(String) }),
                expect.any(Function)
            );
            expect(mockClient.updateSsid).toHaveBeenCalledWith('wlan-1', 'ssid-1', ssid, 'test-site');
        });
    });
});
