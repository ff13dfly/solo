const runner = require('../logic/runner');
const setPath = runner._setPath;

describe('runner - prototype pollution defense', () => {
    afterEach(() => {
        delete Object.prototype.polluted;
        delete Object.prototype.isAdmin;
    });

    test('blocks __proto__ assignment', () => {
        const target = {};
        const res = setPath(target, '__proto__.polluted', 'hacked');
        expect(res).toBe(false);
        expect({}.polluted).toBeUndefined();
        expect(target.polluted).toBeUndefined();
    });

    test('blocks constructor.prototype assignment', () => {
        const target = {};
        const res = setPath(target, 'constructor.prototype.isAdmin', true);
        expect(res).toBe(false);
        expect({}.isAdmin).toBeUndefined();
    });

    test('blocks prototype property in any segment', () => {
        const target = {};
        const res = setPath(target, 'a.b.prototype.c', 'evil');
        expect(res).toBe(false);
        expect(target.a).toBeUndefined();
    });

    test('safely sets legitimate nested paths', () => {
        const target = { step: { s1: { params: {} } }, input: {} };
        const res = setPath(target, 'step.s1.params.amount', 42);
        expect(res).toBe(true);
        expect(target.step.s1.params.amount).toBe(42);
        expect(target.input.amount).toBe(42);
    });

    test('resolveVariable and extractPath block prototype chain access (__proto__, constructor, prototype, toString)', () => {
        const ctx = { input: { name: 'alice' } };
        expect(runner._resolveVariable('$input.name', ctx)).toBe('alice');
        expect(runner._resolveVariable('$input.__proto__', ctx)).toBeUndefined();
        expect(runner._resolveVariable('$input.constructor', ctx)).toBeUndefined();
        expect(runner._resolveVariable('$input.toString', ctx)).toBeUndefined();

        const obj = { data: { id: 7 } };
        expect(runner._extractPath(obj, 'data.id')).toBe(7);
        expect(runner._extractPath(obj, 'data.__proto__')).toBeUndefined();
        expect(runner._extractPath(obj, 'data.constructor.name')).toBeUndefined();
        expect(runner._extractPath(obj, 'data.toString')).toBeUndefined();
    });

    test('resolveVariables strips __proto__, constructor, and prototype keys', () => {
        const raw = JSON.parse('{"a":"$input.x","__proto__":{"polluted":1},"constructor":{"bad":1},"prototype":{"bad":2}}');
        const resolved = runner._resolveVariables(raw, { input: { x: 'ok' } });
        expect(resolved).toEqual({ a: 'ok' });
        expect(({}).polluted).toBeUndefined();
    });
});

