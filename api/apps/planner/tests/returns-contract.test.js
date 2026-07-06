/**
 * returns-contract.test.js — proves planner.{agenda,todo}.* ACTUAL handler output
 * satisfies the declared return contract (introspection `returns_schema`). Hermetic:
 * real logic + real Entity Factory over an injected Map-backed fake Redis (the
 * collection/returns-contract.test.js pattern). No stack, no live Redis.
 *
 * Why this matters: orchestration/AI bind to these return shapes via returns_schema.
 * agenda/todo CRUD resolve to Entity-Factory records; agenda.sync/todo.sync return the
 * business-critical idMap. This test makes the declaration honest about what the code
 * does TODAY (incl. the agenda-hard-delete vs todo-soft-delete divergence).
 *
 * The two AI stubs (analyze/schedule) live inline in index.js, not in logic/, so their
 * static shape is asserted directly against the literal index.js returns here too.
 */
const os = require('os');
const path = require('path');
process.env.LOG_DIR = path.join(os.tmpdir(), `solo-planner-contract-${process.pid}`);

const createLogic = require('../logic');
const introspection = require('../handlers/introspection');
const config = require('../config');
const { checkReturn } = require('../../../library/contract');

// fake redis — Entity-Factory (string path) commands plus `exists` (used by sync).
// No duplicate()/watch()/xAdd → entity.update takes the degraded read-modify-write path
// and WAL goes to the file logger under LOG_DIR (set above), never to a real stream.
function makeFakeRedis() {
    const kv = new Map();
    const sets = new Map();
    const getSet = (k) => (sets.has(k) ? sets.get(k) : sets.set(k, new Set()).get(k));
    const apply = {
        set: (k, v, opts) => { if (opts && opts.NX && kv.has(k)) return null; kv.set(k, v); return 'OK'; },
        sAdd: (k, m) => { const s = getSet(k); const had = s.has(m); s.add(m); return had ? 0 : 1; },
        del: (k) => { const had = kv.delete(k); sets.delete(k); return had ? 1 : 0; },
        sRem: (k, m) => { const s = sets.get(k); return s && s.delete(m) ? 1 : 0; },
    };
    return {
        async get(k) { return kv.has(k) ? kv.get(k) : null; },
        async set(k, v, opts) { return apply.set(k, v, opts); },
        async del(k) { return apply.del(k); },
        async exists(k) { return kv.has(k) ? 1 : 0; },
        async mGet(keys) { return keys.map((k) => (kv.has(k) ? kv.get(k) : null)); },
        async sAdd(k, m) { return apply.sAdd(k, m); },
        async sMembers(k) { return sets.has(k) ? [...sets.get(k)] : []; },
        async sRem(k, m) { return apply.sRem(k, m); },
        async sIsMember(k, m) { return sets.has(k) && sets.get(k).has(m) ? 1 : 0; },
        multi() {
            const ops = [];
            const chain = {
                set(k, v, opts) { ops.push(['set', k, v, opts]); return chain; },
                sAdd(k, m) { ops.push(['sAdd', k, m]); return chain; },
                del(k) { ops.push(['del', k]); return chain; },
                sRem(k, m) { ops.push(['sRem', k, m]); return chain; },
                async exec() { return ops.map(([op, ...args]) => apply[op](...args)); },
            };
            return chain;
        },
    };
}

const byName = Object.fromEntries(introspection.map((m) => [m.name, m]));
const method = (n) => byName[n];

const USER = 'uid-test';

describe('planner.* — actual return satisfies declared returns_schema', () => {
    let logic;
    beforeEach(() => { logic = createLogic(makeFakeRedis(), { serviceName: 'planner', config }); });

    // --- AGENDA CRUD ---

    test('agenda.create → matches AGENDA_RETURN (id/status/createdAt/updatedAt present)', async () => {
        const a = await logic.agenda.create(
            { title: 'Standup', date: '2026-06-18', startTime: '09:00', endTime: '09:30', content: 'daily' },
            USER
        );
        expect(checkReturn(method('planner.agenda.create'), a)).toEqual([]);
        expect(typeof a.id).toBe('string');
        expect(a.status).toBe('ACTIVE');
        expect(typeof a.createdAt).toBe('number');
        expect(typeof a.updatedAt).toBe('number');
    });

    test('agenda.get → matches AGENDA_RETURN; round-trips the stored record', async () => {
        const created = await logic.agenda.create(
            { title: 'Review', date: '2026-06-19', startTime: '14:00', endTime: '15:00' },
            USER
        );
        const got = await logic.agenda.get({ id: created.id }, USER);
        expect(checkReturn(method('planner.agenda.get'), got)).toEqual([]);
        expect(got.id).toBe(created.id);
        expect(got.title).toBe('Review');
    });

    test('agenda.update → matches AGENDA_RETURN; updatedAt is a number', async () => {
        const created = await logic.agenda.create(
            { title: 'Plan', date: '2026-06-20', startTime: '10:00', endTime: '11:00' },
            USER
        );
        const updated = await logic.agenda.update({ id: created.id, title: 'Plan v2' }, USER);
        expect(checkReturn(method('planner.agenda.update'), updated)).toEqual([]);
        expect(updated.title).toBe('Plan v2');
        expect(typeof updated.updatedAt).toBe('number');
    });

    test('agenda.delete (hard delete) → matches DELETE_RETURN { success: true }', async () => {
        const created = await logic.agenda.create(
            { title: 'Tmp', date: '2026-06-21', startTime: '08:00', endTime: '08:15' },
            USER
        );
        const res = await logic.agenda.delete({ id: created.id }, USER);
        expect(checkReturn(method('planner.agenda.delete'), res)).toEqual([]);
        expect(res).toEqual({ success: true });
    });

    test('agenda.list → matches LIST_RETURN { items, total }; each item on AGENDA_RETURN', async () => {
        await logic.agenda.create({ title: 'A', date: '2026-06-22', startTime: '09:00', endTime: '10:00' }, USER);
        await logic.agenda.create({ title: 'B', date: '2026-06-22', startTime: '11:00', endTime: '12:00' }, USER);
        const res = await logic.agenda.list({}, USER);
        expect(checkReturn(method('planner.agenda.list'), res)).toEqual([]);
        expect(Array.isArray(res.items)).toBe(true);
        expect(res.total).toBe(2);
        for (const item of res.items) {
            expect(checkReturn(method('planner.agenda.get'), item)).toEqual([]);
        }
    });

    test('agenda.list empty → still matches LIST_RETURN with total 0', async () => {
        const res = await logic.agenda.list({}, 'uid-nobody');
        expect(checkReturn(method('planner.agenda.list'), res)).toEqual([]);
        expect(res.items).toEqual([]);
        expect(res.total).toBe(0);
    });

    // --- AGENDA SYNC ---

    test('agenda.sync → matches SYNC_RETURN { success, count, idMap }; idMap remaps local ids', async () => {
        const res = await logic.agenda.sync({
            events: [
                { id: 'local-1', title: 'Synced', date: '2026-06-23', startTime: '09:00', endTime: '10:00' },
            ],
        }, USER);
        expect(checkReturn(method('planner.agenda.sync'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(res.count).toBe(1);
        expect(typeof res.idMap).toBe('object');
        expect(res.idMap['local-1']).toBeDefined();   // local id mapped to a server id
    });

    test('agenda.sync empty → matches SYNC_RETURN; idMap is {}', async () => {
        const res = await logic.agenda.sync({ events: [] }, USER);
        expect(checkReturn(method('planner.agenda.sync'), res)).toEqual([]);
        expect(res.count).toBe(0);
        expect(res.idMap).toEqual({});
    });

    // --- TODO CRUD ---

    test('todo.create → matches TODO_RETURN', async () => {
        const t = await logic.todo.create({ name: 'Project X', content: '# milestones' }, USER);
        expect(checkReturn(method('planner.todo.create'), t)).toEqual([]);
        expect(typeof t.id).toBe('string');
        expect(t.status).toBe('ACTIVE');
        expect(t.name).toBe('Project X');
    });

    test('todo.get → matches TODO_RETURN', async () => {
        const created = await logic.todo.create({ name: 'Read', content: 'books' }, USER);
        const got = await logic.todo.get({ id: created.id }, USER);
        expect(checkReturn(method('planner.todo.get'), got)).toEqual([]);
        expect(got.content).toBe('books');
    });

    test('todo.update → matches TODO_RETURN', async () => {
        const created = await logic.todo.create({ name: 'Write', content: 'draft' }, USER);
        const updated = await logic.todo.update({ id: created.id, content: 'final' }, USER);
        expect(checkReturn(method('planner.todo.update'), updated)).toEqual([]);
        expect(updated.content).toBe('final');
    });

    test('todo.delete (soft delete) → returns the updated entity (status=DELETED), matches TODO_RETURN', async () => {
        const created = await logic.todo.create({ name: 'Drop', content: 'x' }, USER);
        const res = await logic.todo.delete({ id: created.id }, USER);
        // Divergence vs agenda.delete: todo is softDelete → entity.update result, NOT {success}.
        expect(checkReturn(method('planner.todo.delete'), res)).toEqual([]);
        expect(res.id).toBe(created.id);
        expect(res.status).toBe('DELETED');
    });

    test('todo.list → matches LIST_RETURN; each item on TODO_RETURN', async () => {
        await logic.todo.create({ name: 'T1', content: 'a' }, USER);
        await logic.todo.create({ name: 'T2', content: 'b' }, USER);
        const res = await logic.todo.list({}, USER);
        expect(checkReturn(method('planner.todo.list'), res)).toEqual([]);
        expect(res.total).toBe(2);
        for (const item of res.items) {
            expect(checkReturn(method('planner.todo.get'), item)).toEqual([]);
        }
    });

    // --- TODO SYNC ---

    test('todo.sync → matches SYNC_RETURN; idMap remaps local ids', async () => {
        const res = await logic.todo.sync({
            todos: [{ id: 'local-9', name: 'Synced todo', content: 'c' }],
        }, USER);
        expect(checkReturn(method('planner.todo.sync'), res)).toEqual([]);
        expect(res.success).toBe(true);
        expect(res.count).toBe(1);
        expect(res.idMap['local-9']).toBeDefined();
    });

    // --- AI STUBS (inline in index.js) ---
    // The handlers live in index.js, not logic/, so assert their literal shape directly.

    test('todo.analyze / todo.schedule stub shape → matches STUB_RETURN { status, message }', () => {
        const analyze = { status: 'PENDING', message: 'AI analysis logic will be integrated in Phase 2.' };
        const schedule = { status: 'PENDING', message: 'Auto-scheduling engine will be integrated in Phase 2.' };
        expect(checkReturn(method('planner.todo.analyze'), analyze)).toEqual([]);
        expect(checkReturn(method('planner.todo.schedule'), schedule)).toEqual([]);
    });
});
