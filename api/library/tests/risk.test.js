/**
 * Footprint risk classifier (VERSION.md §3.1) — hermetic unit test.
 * Pure function, no I/O.
 */
const { classifyFootprint, isReadMethod } = require('../risk');

describe('library/risk — classifyFootprint', () => {
    test('all-read footprint → LOW', () => {
        const r = classifyFootprint(['planner.task.get', 'planner.task.list', 'notification.inbox.list']);
        // notification is not sensitive here? notification not in default sensitive set → reads stay LOW
        expect(r.level).toBe('LOW');
        expect(r.reasons).toEqual([]);
    });

    test('any write verb → HIGH', () => {
        const r = classifyFootprint(['planner.task.get', 'planner.task.create']);
        expect(r.level).toBe('HIGH');
        expect(r.reasons.some(x => x.includes('create'))).toBe(true);
    });

    test('reads are LOW by default; sensitive-service forcing is opt-in', () => {
        // default: a read of any service is LOW (a pure-read workflow has no external effect)
        expect(classifyFootprint(['user.permit.get']).level).toBe('LOW');
        // opt-in: a deployment can force reads of a sensitive service to HIGH
        const r = classifyFootprint(['user.permit.get'], { sensitiveServices: ['user'] });
        expect(r.level).toBe('HIGH');
        expect(r.reasons[0]).toMatch(/sensitive service 'user'/);
    });

    test('unknown verb classifies as WRITE (default-deny on the read side)', () => {
        const r = classifyFootprint(['planner.task.frobnicate']);
        expect(r.level).toBe('HIGH');
        expect(r.reasons[0]).toMatch(/write action 'frobnicate'/);
    });

    test('known read verbs stay LOW; send/record/charge are writes', () => {
        expect(classifyFootprint(['planner.task.status', 'planner.task.resolve']).level).toBe('LOW');
        expect(classifyFootprint(['gateway.email.send']).level).toBe('HIGH');     // gateway sensitive + write
        expect(classifyFootprint(['collection.payment.record']).level).toBe('HIGH');
    });

    test('extraReadVerbs widens the read set', () => {
        expect(classifyFootprint(['planner.task.peek']).level).toBe('LOW');       // peek is a default read
        expect(classifyFootprint(['planner.task.glance']).level).toBe('HIGH');    // not a read by default
        expect(classifyFootprint(['planner.task.glance'], { extraReadVerbs: ['glance'] }).level).toBe('LOW');
    });

    test('custom sensitive-service override', () => {
        expect(classifyFootprint(['planner.task.get'], { sensitiveServices: ['planner'] }).level).toBe('HIGH');
    });

    test('empty / malformed input → LOW (nothing to do)', () => {
        expect(classifyFootprint([]).level).toBe('LOW');
        expect(classifyFootprint([null, '', 123]).level).toBe('LOW');
    });

    test('no-arg call → methods defaults to [] → LOW, no reasons', () => {
        // Exercises the `methods = []` default-arg: omitting the argument entirely
        // must classify as an empty (LOW) footprint, not throw.
        expect(classifyFootprint()).toEqual({ level: 'LOW', reasons: [] });
    });

    test('explicit null footprint → treated as empty (the `methods || []` guard)', () => {
        // The default-arg only fills in for `undefined`; an explicit `null` slips
        // past it and is caught by `for (const m of (methods || []))`.
        expect(classifyFootprint(null)).toEqual({ level: 'LOW', reasons: [] });
    });

    test('isReadMethod: non-string / empty method → "" action → not a read', () => {
        // Reaches actionOf's input guard directly (classifyFootprint pre-filters
        // these out before they get there). A blank action is in no read set.
        const verbs = new Set(['get']);
        expect(isReadMethod(123, verbs)).toBe(false);    // non-string → ''
        expect(isReadMethod('', verbs)).toBe(false);     // empty string → ''
        expect(isReadMethod(null, verbs)).toBe(false);   // null → ''
        // sanity: a genuine read still resolves true via the same path
        expect(isReadMethod('planner.task.get', verbs)).toBe(true);
    });
});
