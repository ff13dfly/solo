/**
 * fieldmask.test.js — 字段级数据权限库 hermetic 单测。
 * 库此前零测试;这里锁住 strip/pick/apply/define 的语义(尤其 apply 的
 * show 白名单优先、method∪* hide、数组逐项遮蔽)——数据级安全的基石。
 */
const fieldmask = require('../fieldmask');

describe('fieldmask.strip (黑名单, 递归)', () => {
    test('删对象里的 hide 字段', () => {
        expect(fieldmask.strip({ id: 1, cost: 99, name: 'A' }, ['cost'])).toEqual({ id: 1, name: 'A' });
    });
    test('对数组逐项删', () => {
        expect(fieldmask.strip([{ id: 1, cost: 9 }, { id: 2, cost: 8 }], ['cost'])).toEqual([{ id: 1 }, { id: 2 }]);
    });
    test('递归进嵌套对象', () => {
        expect(fieldmask.strip({ id: 1, inner: { cost: 5, ok: 1 } }, ['cost'])).toEqual({ id: 1, inner: { ok: 1 } });
    });
    test('空字段集 → 原样返回(同引用)', () => {
        const o = { a: 1 };
        expect(fieldmask.strip(o, [])).toBe(o);
    });
});

describe('fieldmask.pick (白名单, 仅顶层)', () => {
    test('只留列出的顶层字段', () => {
        expect(fieldmask.pick({ id: 1, cost: 99, name: 'A' }, ['id', 'name'])).toEqual({ id: 1, name: 'A' });
    });
    test('对数组逐项 pick', () => {
        expect(fieldmask.pick([{ id: 1, cost: 9 }], ['id'])).toEqual([{ id: 1 }]);
    });
});

describe('fieldmask.apply (constraints 驱动)', () => {
    const data = { id: 1, amount: 100, currency: 'CNY', orderId: 'o1' };

    test('无 constraints → 原样(同引用)', () => {
        expect(fieldmask.apply(data, 'collection.payment.get', undefined)).toBe(data);
    });
    test('method 级 hide → 删该字段', () => {
        const c = { 'collection.payment.get': { hide: ['amount'] } };
        expect(fieldmask.apply(data, 'collection.payment.get', c)).toEqual({ id: 1, currency: 'CNY', orderId: 'o1' });
    });
    test('method 级 show → 只留该字段', () => {
        const c = { 'collection.payment.get': { show: ['id', 'orderId'] } };
        expect(fieldmask.apply(data, 'collection.payment.get', c)).toEqual({ id: 1, orderId: 'o1' });
    });
    test('全局 * hide(无 method 规则时生效)', () => {
        const c = { '*': { hide: ['amount'] } };
        expect(fieldmask.apply(data, 'collection.payment.get', c).amount).toBeUndefined();
    });
    test('show 优先于 hide(白名单优先)', () => {
        const c = { 'collection.payment.get': { show: ['id'], hide: ['id'] } };
        expect(fieldmask.apply(data, 'collection.payment.get', c)).toEqual({ id: 1 });
    });
    test('method 级 hide ∪ 全局 hide(取并集)', () => {
        const c = { 'collection.payment.get': { hide: ['amount'] }, '*': { hide: ['currency'] } };
        const r = fieldmask.apply(data, 'collection.payment.get', c);
        expect(r.amount).toBeUndefined();
        expect(r.currency).toBeUndefined();
        expect(r.id).toBe(1);
    });
    test('数组结果逐项遮蔽', () => {
        const arr = [{ id: 1, amount: 10 }, { id: 2, amount: 20 }];
        const c = { 'collection.payment.list': { hide: ['amount'] } };
        expect(fieldmask.apply(arr, 'collection.payment.list', c)).toEqual([{ id: 1 }, { id: 2 }]);
    });
});

describe('fieldmask.define (角色静态黑名单)', () => {
    const mask = fieldmask.define({ admin: [], user: ['cost'] });
    test('admin(permit 字符串) → 不删', () => {
        expect(mask.forUser({ id: 1, cost: 9 }, 'admin')).toEqual({ id: 1, cost: 9 });
    });
    test('user → 删角色字段', () => {
        expect(mask.forUser({ id: 1, cost: 9 }, 'user')).toEqual({ id: 1 });
    });
    test('permit 对象 allow_all → 视作 admin', () => {
        expect(mask.forUser({ id: 1, cost: 9 }, { allow_all: true })).toEqual({ id: 1, cost: 9 });
    });
    test('未知角色回退到 user 规则(?? 第二支)', () => {
        // role='operator' 不在规则表 → roleRules['operator'] 为 undefined → 回退 user 的 ['cost']
        const m = fieldmask.define({ user: ['cost'] });
        expect(m.forUser({ id: 1, cost: 9 }, { role: 'operator' })).toEqual({ id: 1 });
    });
    test('未知角色且无 user 兜底 → 不过滤(?? 落到 [])', () => {
        // role='operator' 既不在表中也无 'user' 键 → fields=[] → 原样(同引用)
        const m = fieldmask.define({ admin: ['secret'] });
        const data = { id: 1, secret: 's' };
        expect(m.forUser(data, { role: 'operator' })).toBe(data);
    });
});

describe('fieldmask — 边界分支补全', () => {
    test('pick: 空字段集 → 原样返回(同引用)', () => {
        const o = { a: 1, b: 2 };
        expect(fieldmask.pick(o, [])).toBe(o);
    });
    test('pick: 标量 / null 输入(非对象非数组)→ 原样返回', () => {
        expect(fieldmask.pick(5, ['id'])).toBe(5);
        expect(fieldmask.pick('x', ['id'])).toBe('x');
        expect(fieldmask.pick(null, ['id'])).toBeNull();
    });
    test('pick: 数组内含标量 / null → 逐项处理, 标量原样保留', () => {
        expect(fieldmask.pick([{ id: 1, c: 2 }, 7, null], ['id'])).toEqual([{ id: 1 }, 7, null]);
    });
    test('apply: constraints 存在但无 show/hide 规则 → 原样(同引用)', () => {
        const data = { id: 1, amount: 100 };
        expect(fieldmask.apply(data, 'collection.payment.get', {})).toBe(data);
        expect(fieldmask.apply(data, 'collection.payment.get', { 'collection.payment.get': {} })).toBe(data);
    });
});
