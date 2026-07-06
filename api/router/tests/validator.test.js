// Pin the OOM-shield ceiling to a controlled threshold BEFORE requiring the validator, so the
// size assertions below test the shield *logic* at a known limit instead of accidentally depending
// on the shipping default (config.js:71 = 5MB, which silently broke these once the default was
// loosened from 100KB). validator.js captures MAX_STRING_LENGTH at module-load from config.js
// (which reads process.env.MAX_STRING_LENGTH), so we set the env only for the require, then restore
// it immediately — under jest --runInBand the process is shared, and we must not leak this ceiling
// to other suites.
const _savedMaxStr = process.env.MAX_STRING_LENGTH;
process.env.MAX_STRING_LENGTH = '102400';
const { validateParams, validateGlobalConstraints, isPublicMethod } = require('../handlers/validator');
if (_savedMaxStr === undefined) delete process.env.MAX_STRING_LENGTH;
else process.env.MAX_STRING_LENGTH = _savedMaxStr;

describe('Validator Handler', () => {

    // ─────────────────────────────────────────────────────────────────────────
    describe('validateGlobalConstraints (OOM Shield)', () => {

        test('returns null for normal params', () => {
            expect(validateGlobalConstraints({ name: 'test', count: 5 })).toBeNull();
        });

        test('returns null when params is null', () => {
            expect(validateGlobalConstraints(null)).toBeNull();
        });

        test('returns null for null/undefined field values', () => {
            expect(validateGlobalConstraints({ a: null, b: undefined })).toBeNull();
        });

        test('rejects string exceeding 102400 chars', () => {
            const result = validateGlobalConstraints({ name: 'x'.repeat(102401) });
            expect(result).not.toBeNull();
            expect(result.code).toBe(-32602);
            expect(result.message).toContain('exceeds maximum');
        });

        test('rejects array exceeding 1000 items', () => {
            const result = validateGlobalConstraints({ ids: new Array(1001).fill(1) });
            expect(result).not.toBeNull();
            expect(result.code).toBe(-32602);
            expect(result.message).toContain('exceeds maximum');
        });

        test('rejects object whose serialized size exceeds 204800 chars', () => {
            // {"data":{"k":"x...x"}} — outer wrapper adds ~14 chars, so value must be > 204786 chars
            const result = validateGlobalConstraints({ data: { k: 'x'.repeat(204800) } });
            expect(result).not.toBeNull();
            expect(result.code).toBe(-32602);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('validateParams (Schema Enforcer)', () => {

        test('returns null when no schema provided', () => {
            expect(validateParams({}, null)).toBeNull();
            expect(validateParams({}, [])).toBeNull();
        });

        test('rejects when required param is missing', () => {
            const schema = [{ name: 'id', type: 'string', required: true }];
            const result = validateParams({}, schema);
            expect(result).not.toBeNull();
            expect(result.code).toBe(-32602);
            expect(result.message).toContain("'id'");
        });

        test('rejects wrong type for number param', () => {
            const schema = [{ name: 'age', type: 'number', required: true }];
            const result = validateParams({ age: 'twenty' }, schema);
            expect(result).not.toBeNull();
            expect(result.code).toBe(-32602);
            expect(result.message).toContain('number');
        });

        test('rejects wrong type for array param', () => {
            const schema = [{ name: 'tags', type: 'array' }];
            const err = validateParams({ tags: 'string' }, schema);
            expect(err).not.toBeNull();
            expect(err.message).toContain('array');
        });

        test('accepts valid array param', () => {
            const schema = [{ name: 'tags', type: 'array' }];
            expect(validateParams({ tags: ['a', 'b'] }, schema)).toBeNull();
        });

        test('returns null when all params are valid', () => {
            const schema = [
                { name: 'id', type: 'string', required: true },
                { name: 'opt', type: 'boolean' }
            ];
            expect(validateParams({ id: '123', opt: true }, schema)).toBeNull();
        });

        test('ignores undefined optional params', () => {
            const schema = [{ name: 'opt', type: 'boolean' }];
            expect(validateParams({}, schema)).toBeNull();
        });

        test('rejects optional param when provided with wrong type', () => {
            const schema = [{ name: 'flag', type: 'boolean' }];
            const result = validateParams({ flag: 'yes' }, schema);
            expect(result).not.toBeNull();
            expect(result.message).toContain('boolean');
        });

        test('accepts object type param', () => {
            const schema = [{ name: 'payload', type: 'object' }];
            expect(validateParams({ payload: { key: 'val' } }, schema)).toBeNull();
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    describe('isPublicMethod', () => {
        // Based on actual system.js registry

        test('ping is public', () => {
            expect(isPublicMethod('ping')).toBe(true);
        });

        test('system.capability.list is public', () => {
            expect(isPublicMethod('system.capability.list')).toBe(true);
        });

        test('system.service.list is public', () => {
            expect(isPublicMethod('system.service.list')).toBe(true);
        });

        test('agent.chat is NOT public (narrowed — auth required)', () => {
            expect(isPublicMethod('agent.chat')).toBe(false);
        });

        test('system.service.add is NOT public', () => {
            expect(isPublicMethod('system.service.add')).toBe(false);
        });

        test('admin.log.debug is NOT public', () => {
            expect(isPublicMethod('admin.log.debug')).toBe(false);
        });

        test('unknown method returns false', () => {
            expect(isPublicMethod('unknown.method')).toBe(false);
            expect(isPublicMethod('')).toBe(false);
        });
    });

});
