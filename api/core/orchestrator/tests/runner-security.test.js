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
});
