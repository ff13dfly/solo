/**
 * Hermetic test for logger.redactSensitive — the denylist masking applied to params before
 * they're pushed to ERROR:QUEUE, so credentials (passport deviceToken, login challenge/response,
 * passwords…) never leak into the error log. Pure function, no I/O.
 */
const { redactSensitive } = require('../logger');

describe('logger.redactSensitive', () => {
    test('masks credential-named keys at the top level', () => {
        const out = redactSensitive({
            anchor: 'user@x.com', deviceId: 'dev-1',
            deviceToken: 'SECRET32', password: 'p', challenge: 'c', response: 'r', otp: '123456',
        });
        expect(out.deviceToken).toBe('***');
        expect(out.password).toBe('***');
        expect(out.challenge).toBe('***');
        expect(out.response).toBe('***');
        expect(out.otp).toBe('***');
        // non-sensitive preserved
        expect(out.anchor).toBe('user@x.com');
        expect(out.deviceId).toBe('dev-1');
    });

    test('is case-insensitive', () => {
        const out = redactSensitive({ DeviceToken: 'a', PASSWORD: 'b', Token: 'c' });
        expect(out).toEqual({ DeviceToken: '***', PASSWORD: '***', Token: '***' });
    });

    test('masks nested objects and arrays', () => {
        const out = redactSensitive({
            user: 'u-1',
            permit: { services: {}, token: 'nested-secret' },
            devices: [{ deviceId: 'd1', deviceToken: 'aa' }, { deviceId: 'd2', deviceToken: 'bb' }],
        });
        expect(out.user).toBe('u-1');
        expect(out.permit.token).toBe('***');
        expect(out.permit.services).toEqual({});
        expect(out.devices[0].deviceToken).toBe('***');
        expect(out.devices[0].deviceId).toBe('d1');
        expect(out.devices[1].deviceToken).toBe('***');
    });

    test('tolerates non-objects / null / undefined', () => {
        expect(redactSensitive(undefined)).toBeUndefined();
        expect(redactSensitive(null)).toBeNull();
        expect(redactSensitive('plain')).toBe('plain');
        expect(redactSensitive(42)).toBe(42);
    });

    test('does not mutate the input', () => {
        const input = { deviceToken: 'live' };
        const out = redactSensitive(input);
        expect(input.deviceToken).toBe('live');   // original untouched
        expect(out.deviceToken).toBe('***');
    });

    test('stops at depth bound (no runaway on deeply nested)', () => {
        let deep = { token: 'x' };
        for (let i = 0; i < 10; i++) deep = { nest: deep };
        // should not throw; shallow levels still get redacted
        expect(() => redactSensitive(deep)).not.toThrow();
    });
});
