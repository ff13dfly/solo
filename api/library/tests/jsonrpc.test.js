/**
 * Hermetic unit test for library/jsonrpc.js — the JSON-RPC 2.0 error catalog
 * and HTTP response wrappers. The module is PURE (no redis, no network, no
 * time, no fs), so behavior is asserted directly. The only collaborator is an
 * Express-like `res`, which we fake with chainable json/status spies.
 */
const J = require('../jsonrpc');

// Minimal Express-style res double: status() is chainable, json() records.
function makeRes() {
    const res = {
        statusCode: undefined,
        body: undefined,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
    jest.spyOn(res, 'status');
    jest.spyOn(res, 'json');
    return res;
}

describe('jsonrpc — protocol error builders (codes + messages)', () => {
    test('INVALID_REQUEST is -32600 / "Invalid Request"', () => {
        expect(J.INVALID_REQUEST()).toEqual({ code: -32600, message: 'Invalid Request' });
    });
    test('METHOD_NOT_FOUND interpolates the method name', () => {
        expect(J.METHOD_NOT_FOUND('user.account.create')).toEqual({
            code: -32601,
            message: 'Method user.account.create not found',
        });
    });
    test('INVALID_PARAMS uses given msg, falls back to default', () => {
        expect(J.INVALID_PARAMS('bad shape')).toEqual({ code: -32602, message: 'bad shape' });
        expect(J.INVALID_PARAMS()).toEqual({ code: -32602, message: 'Invalid params' });
        expect(J.INVALID_PARAMS('')).toEqual({ code: -32602, message: 'Invalid params' }); // empty → default
    });
    test('MISSING_PARAM interpolates the param name', () => {
        expect(J.MISSING_PARAM('email')).toEqual({ code: -32602, message: 'Missing parameter: email' });
    });
    test('INTERNAL_ERROR uses given msg, falls back to default', () => {
        expect(J.INTERNAL_ERROR('boom')).toEqual({ code: -32603, message: 'boom' });
        expect(J.INTERNAL_ERROR()).toEqual({ code: -32603, message: 'Internal Error' });
    });
});

describe('jsonrpc — auth / permission error builders', () => {
    test('AUTH_REQUIRED is -32001', () => {
        expect(J.AUTH_REQUIRED()).toEqual({ code: -32001, message: 'Authorization Required' });
    });
    test('INVALID_SIGNATURE shares code -32001 with a distinct message', () => {
        expect(J.INVALID_SIGNATURE()).toEqual({ code: -32001, message: 'Invalid Router Signature' });
    });
    test('UNAUTHORIZED is -32003', () => {
        expect(J.UNAUTHORIZED()).toEqual({ code: -32003, message: 'Unauthorized' });
    });
    test('FORBIDDEN uses reason, falls back to default', () => {
        expect(J.FORBIDDEN('not your order')).toEqual({ code: -32005, message: 'not your order' });
        expect(J.FORBIDDEN()).toEqual({ code: -32005, message: 'Forbidden' });
        expect(J.FORBIDDEN('')).toEqual({ code: -32005, message: 'Forbidden' }); // empty → default
    });
});

describe('jsonrpc — business-domain error builders', () => {
    test('NOT_FOUND interpolates entity, defaults to Resource', () => {
        expect(J.NOT_FOUND('Order')).toEqual({ code: -32002, message: 'Order not found' });
        expect(J.NOT_FOUND()).toEqual({ code: -32002, message: 'Resource not found' });
    });
    test('ALREADY_EXISTS interpolates entity, defaults to Resource', () => {
        expect(J.ALREADY_EXISTS('User')).toEqual({ code: -32004, message: 'User already exists' });
        expect(J.ALREADY_EXISTS()).toEqual({ code: -32004, message: 'Resource already exists' });
    });
});

describe('jsonrpc — backward-compatible aliases', () => {
    test('INVALID_PARAM is the same function as INVALID_PARAMS', () => {
        expect(J.INVALID_PARAM).toBe(J.INVALID_PARAMS);
        expect(J.INVALID_PARAM('x')).toEqual({ code: -32602, message: 'x' });
    });
    test('RESOURCE_NOT_FOUND is the same function as NOT_FOUND', () => {
        expect(J.RESOURCE_NOT_FOUND).toBe(J.NOT_FOUND);
        expect(J.RESOURCE_NOT_FOUND('Thing')).toEqual({ code: -32002, message: 'Thing not found' });
    });
});

describe('jsonrpc — success() wrapper shape', () => {
    test('wraps result with jsonrpc/version + id, returns res', () => {
        const res = makeRes();
        const ret = J.success(res, { ok: true, n: 7 }, 'req-1');
        expect(ret).toBe(res);                 // returns res.json(...) which returns res
        expect(res.json).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled(); // success never touches status
        expect(res.body).toEqual({
            jsonrpc: '2.0',
            id: 'req-1',
            result: { ok: true, n: 7 },
        });
        expect(res.body).not.toHaveProperty('error');
    });
    test('missing id → null; undefined id → null', () => {
        const r1 = makeRes();
        J.success(r1, 'X');                    // id undefined
        expect(r1.body).toEqual({ jsonrpc: '2.0', id: null, result: 'X' });

        const r2 = makeRes();
        J.success(r2, 'X', null);              // id null
        expect(r2.body.id).toBeNull();
    });
    test('id of 0 is preserved (not coerced to null)', () => {
        const res = makeRes();
        J.success(res, 'X', 0);
        expect(res.body.id).toBe(0);
    });
    test('falsy/empty results are passed through verbatim', () => {
        const rNull = makeRes();
        J.success(rNull, null, 'i');
        expect(rNull.body.result).toBeNull();

        const rEmpty = makeRes();
        J.success(rEmpty, {}, 'i');
        expect(rEmpty.body.result).toEqual({});

        const rArr = makeRes();
        J.success(rArr, [], 'i');
        expect(rArr.body.result).toEqual([]);
    });
});

describe('jsonrpc — error() wrapper shape', () => {
    test('wraps an error builder result into payload.error, default http 200', () => {
        const res = makeRes();
        const ret = J.error(res, J.NOT_FOUND('Order'), 'req-9');
        expect(ret).toBe(res);
        expect(res.status).not.toHaveBeenCalled();          // httpStatus defaults to 200 → no status() call
        expect(res.body).toEqual({
            jsonrpc: '2.0',
            id: 'req-9',
            error: { code: -32002, message: 'Order not found' },
        });
        expect(res.body).not.toHaveProperty('result');
    });
    test('non-200 httpStatus sets res.status(...) once', () => {
        const res = makeRes();
        J.error(res, J.FORBIDDEN('nope'), 'req-x', 403);
        expect(res.status).toHaveBeenCalledTimes(1);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toEqual({ code: -32005, message: 'nope' });
    });
    test('explicit httpStatus 200 still does NOT call res.status', () => {
        const res = makeRes();
        J.error(res, J.INTERNAL_ERROR('x'), 'id', 200);
        expect(res.status).not.toHaveBeenCalled();
    });
    test('missing id on error → null', () => {
        const res = makeRes();
        J.error(res, J.UNAUTHORIZED());
        expect(res.body.id).toBeNull();
    });
    test('id field is stripped from the error body, message preserved', () => {
        // wrap() destructures { id, ...errorBody } off the error object: a stray
        // `id` on the error must NOT leak into payload.error.
        const res = makeRes();
        J.error(res, { code: -32002, message: 'gone', id: 'LEAK', detail: 'extra' }, 'outer-id');
        expect(res.body.id).toBe('outer-id');              // top-level id comes from the id arg
        expect(res.body.error).toEqual({                   // inner id removed; detail kept
            code: -32002,
            message: 'gone',
            detail: 'extra',
        });
        expect(res.body.error).not.toHaveProperty('id');
    });
    test('error body always carries a message key from data.message', () => {
        const res = makeRes();
        J.error(res, { code: -32099, message: 'custom' }, 'id');
        expect(res.body.error.message).toBe('custom');
        expect(res.body.error.code).toBe(-32099);
    });
});

describe('jsonrpc — exported surface', () => {
    test('all documented helpers/builders are exported and callable', () => {
        const names = [
            'success', 'error',
            'INVALID_REQUEST', 'METHOD_NOT_FOUND', 'INVALID_PARAMS', 'INVALID_PARAM',
            'MISSING_PARAM', 'INTERNAL_ERROR',
            'AUTH_REQUIRED', 'INVALID_SIGNATURE', 'UNAUTHORIZED', 'FORBIDDEN',
            'NOT_FOUND', 'RESOURCE_NOT_FOUND', 'ALREADY_EXISTS',
        ];
        for (const n of names) {
            expect(typeof J[n]).toBe('function');
        }
    });
});
