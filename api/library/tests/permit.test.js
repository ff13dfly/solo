/**
 * permit.js — permit interpretation SDK tests.
 *
 * The object-path matchers (hasPermit/coversAll) must stay equivalent to the
 * Router's checkPermission (api/router/handlers/auth.js). A copy of that function
 * is embedded below as an oracle; a cross-check test asserts hasPermit agrees
 * with it across a matrix of permits × methods. If the Router contract changes,
 * that test fails loudly — which is the whole point.
 */
const permit = require('../permit');

// Oracle: byte-for-byte the Router's checkPermission, but takes a fully-qualified
// method and derives the service segment (Router gets service separately).
function routerOracle(permitObj, method) {
    const svc = method.includes('.') ? method.slice(0, method.indexOf('.')) : null;
    if (!permitObj) return false;
    if (permitObj.allow_all) return true;
    if (!permitObj.services) return false;
    if (!svc) return false;
    const allowed = permitObj.services[svc];
    if (!allowed) return false;
    if (allowed.includes('*')) return true;
    if (allowed.includes(method)) return true;
    return false;
}

describe('serviceOf', () => {
    test('extracts service segment', () => {
        expect(permit.serviceOf('erp.stock.query')).toBe('erp');
        expect(permit.serviceOf('ledger.transfer')).toBe('ledger');
    });
    test('rejects unparseable', () => {
        expect(permit.serviceOf('noprefix')).toBeNull();
        expect(permit.serviceOf('.leading')).toBeNull();
        expect(permit.serviceOf('')).toBeNull();
        expect(permit.serviceOf(null)).toBeNull();
        expect(permit.serviceOf(undefined)).toBeNull();
    });
});

describe('hasPermit', () => {
    test('null/empty permit denies', () => {
        expect(permit.hasPermit(null, 'erp.stock.query')).toBe(false);
        expect(permit.hasPermit(undefined, 'erp.stock.query')).toBe(false);
        expect(permit.hasPermit({}, 'erp.stock.query')).toBe(false);
    });
    test('allow_all grants anything', () => {
        expect(permit.hasPermit({ allow_all: true }, 'ledger.transfer')).toBe(true);
        expect(permit.hasPermit({ allow_all: true, services: {} }, 'anything.at.all')).toBe(true);
    });
    test('exact method match', () => {
        const p = { allow_all: false, services: { erp: ['erp.stock.query'] } };
        expect(permit.hasPermit(p, 'erp.stock.query')).toBe(true);
        expect(permit.hasPermit(p, 'erp.stock.create')).toBe(false);
    });
    test('service-level wildcard', () => {
        const p = { allow_all: false, services: { erp: ['*'] } };
        expect(permit.hasPermit(p, 'erp.stock.query')).toBe(true);
        expect(permit.hasPermit(p, 'erp.anything')).toBe(true);
        expect(permit.hasPermit(p, 'ledger.transfer')).toBe(false); // wildcard is per-service
    });
    test('unknown service denies', () => {
        const p = { allow_all: false, services: { erp: ['*'] } };
        expect(permit.hasPermit(p, 'ledger.transfer')).toBe(false);
    });
    test('unparseable method denies (no service segment)', () => {
        const p = { allow_all: false, services: { erp: ['*'] } };
        expect(permit.hasPermit(p, 'noprefix')).toBe(false);
    });
});

describe('coversAll', () => {
    const p = { allow_all: false, services: { erp: ['erp.stock.query', 'erp.stock.create'], mail: ['*'] } };
    test('empty footprint is vacuously covered', () => {
        expect(permit.coversAll(p, [])).toBe(true);
    });
    test('all covered → true', () => {
        expect(permit.coversAll(p, ['erp.stock.query', 'mail.send'])).toBe(true);
    });
    test('one missing → false', () => {
        expect(permit.coversAll(p, ['erp.stock.query', 'ledger.transfer'])).toBe(false);
    });
    test('allow_all covers everything', () => {
        expect(permit.coversAll({ allow_all: true }, ['ledger.transfer', 'bank.send'])).toBe(true);
    });
    test('non-array → false', () => {
        expect(permit.coversAll(p, null)).toBe(false);
    });
});

describe('missingMethods', () => {
    const p = { allow_all: false, services: { erp: ['erp.stock.query'] } };
    test('returns uncovered subset, de-duplicated, order-preserving', () => {
        expect(permit.missingMethods(p, ['erp.stock.query', 'ledger.transfer', 'bank.send', 'ledger.transfer']))
            .toEqual(['ledger.transfer', 'bank.send']);
    });
    test('all covered → empty', () => {
        expect(permit.missingMethods(p, ['erp.stock.query'])).toEqual([]);
    });
    test('allow_all → empty', () => {
        expect(permit.missingMethods({ allow_all: true }, ['ledger.transfer'])).toEqual([]);
    });
    test('non-array → empty', () => {
        expect(permit.missingMethods(p, null)).toEqual([]);
    });
});

describe('isAdmin (string path — what Router forwards)', () => {
    test('compressed string admin', () => {
        expect(permit.isAdmin({ permit: 'admin' })).toBe(true);
    });
    test('compressed string user', () => {
        expect(permit.isAdmin({ permit: 'user' })).toBe(false);
    });
    test('tolerates full object form', () => {
        expect(permit.isAdmin({ permit: { allow_all: true } })).toBe(true);
        expect(permit.isAdmin({ permit: { allow_all: false } })).toBe(false);
    });
    test('missing/empty', () => {
        expect(permit.isAdmin({})).toBe(false);
        expect(permit.isAdmin(null)).toBe(false);
    });
});

describe('getConstraints', () => {
    test('returns forwarded constraints', () => {
        const c = { 'erp.stock.list': { dept: 'A' } };
        expect(permit.getConstraints({ constraints: c })).toBe(c);
    });
    test('always returns an object', () => {
        expect(permit.getConstraints({})).toEqual({});
        expect(permit.getConstraints(null)).toEqual({});
    });
});

describe('CONTRACT: hasPermit agrees with Router checkPermission oracle', () => {
    const permits = [
        null,
        {},
        { allow_all: true },
        { allow_all: false, services: {} },
        { allow_all: false, services: { erp: ['erp.stock.query'] } },
        { allow_all: false, services: { erp: ['*'] } },
        { allow_all: false, services: { erp: ['erp.stock.query'], ledger: ['ledger.transfer'] } },
    ];
    const methods = [
        'erp.stock.query', 'erp.stock.create', 'erp.anything',
        'ledger.transfer', 'bank.send', 'mail.send',
    ];
    test('every (permit, method) pair matches the oracle', () => {
        for (const p of permits) {
            for (const m of methods) {
                expect(permit.hasPermit(p, m)).toBe(routerOracle(p, m));
            }
        }
    });
});
