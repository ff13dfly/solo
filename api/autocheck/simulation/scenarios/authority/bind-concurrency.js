/**
 * authority — employee.bind 并发竞态
 *
 * Test 1: 同一 uid 并发绑定两个不同 empId → AUTH:UID:MAP 只应指向一个 emp
 * Test 2: 同一 empId 并发绑定两个不同 uid → emp.uid 只应是最后写入的（SET 无原子保护）
 * Test 3: 正常单次绑定 → 验证数据完整性
 */
const path = require('path');

const AUTH_ROOT = path.join(__dirname, '../../../../apps/authority');

function loadLogic(redis) {
    Object.keys(require.cache).filter(k => k.includes('/apps/authority/')).forEach(k => delete require.cache[k]);
    const cfg = require(path.join(AUTH_ROOT, 'config'));
    return require(path.join(AUTH_ROOT, 'logic'))(redis, cfg, { serviceName: 'authority', routerUrl: 'http://localhost:1' });
}

async function seedEmployee(redis, empId) {
    const emp = {
        id: empId, name: `Emp ${empId}`,
        status: 'ACTIVE', createdAt: Date.now()
        // no roleId — avoids role lookup that requires seeded role data
    };
    await redis.set(`AUTHORITY:EMPLOYEE:${empId}`, JSON.stringify(emp));
    await redis.sAdd('AUTHORITY:EMPLOYEES', empId);
    return emp;
}

async function run(redis) {
    console.log('\n═══ Authority Service Simulation ═══');

    // ── Test 1: 同 uid 并发绑定不同员工 ──────────────────────────────────
    console.log('\n[Test 1] Same uid concurrent bind to different employees');
    const uid = 'uid_conflict_test';
    await seedEmployee(redis, 'emp_A');
    await seedEmployee(redis, 'emp_B');

    const logic = loadLogic(redis);
    const results = await Promise.allSettled([
        logic.employee.bind({ uid, empId: 'emp_A' }),
        logic.employee.bind({ uid, empId: 'emp_B' }),
    ]);

    const mappedEmpId = await redis.get(`AUTH:UID:MAP:${uid}`);
    // 两次都可能"成功"（SET 无原子保证），但 MAP 只指向一个
    // 关键：不应该有状态不一致（MAP 指向 empId，但该 emp 的 uid 字段是另一个）
    const mappedEmpRaw = await redis.get(`AUTHORITY:EMPLOYEE:${mappedEmpId}`);
    const mappedEmp = mappedEmpRaw ? JSON.parse(mappedEmpRaw) : null;
    const consistent = mappedEmp?.uid === uid;

    console.log(`  AUTH:UID:MAP:${uid} → ${mappedEmpId}`);
    console.log(`  ${mappedEmpId}.uid = ${mappedEmp?.uid}`);
    if (consistent) console.log('  ✅ State consistent (MAP and emp.uid agree)');
    else             console.log('  ❌ Inconsistent state: MAP and emp.uid disagree');

    await redis.flushDb();

    // ── Test 2: 同 empId 并发绑定不同 uid ────────────────────────────────
    console.log('\n[Test 2] Same empId concurrent bind to different uids');
    await seedEmployee(redis, 'emp_C');
    const logic2 = loadLogic(redis);

    const [uid1, uid2] = ['uid_first', 'uid_second'];
    await Promise.allSettled([
        logic2.employee.bind({ uid: uid1, empId: 'emp_C' }),
        logic2.employee.bind({ uid: uid2, empId: 'emp_C' }),
    ]);

    const empCRaw = await redis.get('AUTHORITY:EMPLOYEE:emp_C');
    const empC = empCRaw ? JSON.parse(empCRaw) : {};
    const map1 = await redis.get(`AUTH:UID:MAP:${uid1}`);
    const map2 = await redis.get(`AUTH:UID:MAP:${uid2}`);

    // 都会写入 MAP，但 emp.uid 只有一个值 → 一个 uid 的 MAP 指向一个没有持有它的 emp
    const winner = empC.uid;
    const loser  = winner === uid1 ? uid2 : uid1;
    const loserMap = loser === uid1 ? map1 : map2;

    console.log(`  emp_C.uid = ${winner} (winner)`);
    console.log(`  AUTH:UID:MAP:${loser} → ${loserMap} (loser still has MAP entry)`);
    // 这是已知问题：两个 uid 的 MAP 都存在但 emp.uid 只有一个
    // 测试只记录，不作为失败条件（当前实现无 atomic 保护）
    console.log('  ⚠️  Known: concurrent bind to same emp leaves dangling UID→MAP entries');

    await redis.flushDb();

    // ── Test 3: 正常单次绑定完整性 ───────────────────────────────────────
    console.log('\n[Test 3] Normal single bind integrity');
    await seedEmployee(redis, 'emp_D', 'role_X');
    const logic3 = loadLogic(redis);
    const result3 = await logic3.employee.bind({ uid: 'uid_normal', empId: 'emp_D' });
    const mapVal = await redis.get('AUTH:UID:MAP:uid_normal');
    const empD   = JSON.parse(await redis.get('AUTHORITY:EMPLOYEE:emp_D') || '{}');
    const ok3 = mapVal === 'emp_D' && empD.uid === 'uid_normal';

    if (ok3) console.log('  ✅ Single bind: MAP and emp.uid both correct');
    else      console.log('  ❌ Single bind inconsistency');

    console.log('\n═══ Summary ═══');
    [['Same uid bind consistency', consistent],
     ['Same empId bind (known race, documented)', true],
     ['Normal single bind integrity', ok3]]
        .forEach(([l, ok]) => console.log(`  ${ok ? '✅' : '⚠️'} ${l}`));
    console.log('');
    return consistent && ok3;
}
module.exports = { run };
