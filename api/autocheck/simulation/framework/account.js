/**
 * 账号工厂
 *
 * 直接调用 user service logic 层（不走 HTTP），在测试 Redis 里创建账号并登录。
 * 不经过 SMS/OTP，测试环境下直接计算 challenge response。
 *
 * 用法：
 *   const accounts = await createAccounts(redis, 10);
 *   // accounts[0] = { name, uid, token, hash, salt }
 */

const crypto = require('crypto');
const path = require('path');

// user service logic 需要的最小 config
function makeUserConfig(redis) {
    return {
        serviceName: 'user',
        redis: {
            userPrefix:      'user:',
            userNamePrefix:  'user:name:',
            userIdSet:       'user:ids',
            challengePrefix: 'challenge:',
            sessionPrefix:   'session:',
        },
        defaultIterations: 1000,  // 测试用低迭代数，加快速度
        idLengths: { user: 16 },
        defaultLanguage: 'zh',
    };
}

async function createAccount(redis, name, password = 'test-password') {
    const userLogic = require(path.join(__dirname, '../../../core/user/logic/user'));
    const config = makeUserConfig(redis);
    const logic = userLogic(redis, config);

    const salt = crypto.randomBytes(16).toString('hex');
    // hash = sha256(password + salt)，与生产端计算方式一致
    const hash = crypto.createHash('sha256').update(password + salt).digest('hex');

    await logic.register({ name, salt, hash });
    return { name, password, salt, hash };
}

async function login(redis, name, hash) {
    const userLogic = require(path.join(__dirname, '../../../core/user/logic/user'));
    const config = makeUserConfig(redis);
    const logic = userLogic(redis, config);

    // Step 1: 获取 challenge
    const { challenge } = await logic.loginRequest({ name });

    // Step 2: 计算 response = sha256(challenge + user.hash)
    const response = crypto.createHash('sha256').update(challenge + hash).digest('hex');

    // Step 3: 验证，拿 token
    const { token, uid } = await logic.loginVerify({
        name,
        challenge,
        response,
        deviceId: 'test-device',
    });

    return { token, uid };
}

/**
 * 批量创建 N 个测试账号并登录
 * @returns {Array} [{ name, uid, token, hash, salt }, ...]
 */
async function createAccounts(redis, n = 5, prefix = 'testuser') {
    const accounts = [];
    for (let i = 0; i < n; i++) {
        const name = `${prefix}_${String(i).padStart(3, '0')}`;
        const password = `pw_${name}`;

        const { salt, hash } = await createAccount(redis, name, password);
        const { token, uid } = await login(redis, name, hash);

        accounts.push({ name, uid, token, hash, salt });
        process.stdout.write(`\r[Accounts] Created ${i + 1}/${n}`);
    }
    console.log('');
    return accounts;
}

module.exports = { createAccount, login, createAccounts };
