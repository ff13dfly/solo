const introspection = require('../handlers/introspection');
const config = require('../config');

describe('User Service Introspection', () => {
    test('should expose all required RPC methods', () => {
        const methodNames = introspection.map(m => m.name);
        
        // Base Methods
        expect(methodNames).toContain('user.register');
        expect(methodNames).toContain('user.login.request');
        expect(methodNames).toContain('user.login.verify');
        expect(methodNames).toContain('user.profile');
        expect(methodNames).toContain('user.account.list');

        // Category Methods (New)
        expect(methodNames).toContain('user.category.create');
        expect(methodNames).toContain('user.category.delete');
        expect(methodNames).toContain('user.category.list');
        expect(methodNames).toContain('user.category.get');
        expect(methodNames).toContain('user.category.item.add');
        expect(methodNames).toContain('user.category.item.update');
        expect(methodNames).toContain('user.category.item.remove');
    });

    test('should have documentation for all methods in config', () => {
        const methodNames = introspection.map(m => m.name);
        const enDocs = Object.keys(config.description.en.methods);
        const zhDocs = Object.keys(config.description.zh.methods);

        methodNames.forEach(method => {
            expect(enDocs).toContain(method);
            expect(zhDocs).toContain(method);
        });
    });

    test('should have correct parameter definitions', () => {
        // Param names + the strengthened-schema invariant (every string param declares maxLength —
        // see the param-hardening rollout). Asserting names + invariant rather than the exact literal
        // shape keeps this robust against maxLength/pattern tweaks while still catching dropped params.
        const itemAdd = introspection.find(m => m.name === 'user.category.item.add');
        expect(itemAdd).toBeDefined();
        expect(itemAdd.params.map(p => p.name)).toEqual(['key', 'id', 'label']);
        itemAdd.params.forEach(p => {
            expect(p.type).toBe('string');
            expect(typeof p.maxLength).toBe('number');
        });

        const getCat = introspection.find(m => m.name === 'user.category.get');
        expect(getCat).toBeDefined();
        expect(getCat.params.map(p => p.name)).toEqual(['key']);
        expect(getCat.params[0]).toMatchObject({ name: 'key', type: 'string' });
        expect(typeof getCat.params[0].maxLength).toBe('number');
    });
});
