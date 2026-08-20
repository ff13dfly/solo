/**
 * Router JSON-RPC 客户端 —— service worker 侧**唯一**网络出口。
 *
 * @why 所有后端调用都收在 background，content script 一律不直接发请求：
 *      ① 避开页面 CSP 与 CORS（service worker 的 fetch 只受 host_permissions 约束）；
 *      ② token 不落到目标站点所在的进程里，页面脚本偷不到——插件往往跑在用户真实
 *         登录的第三方后台上，这一条是硬要求。
 *
 * 🔴 **不要在这里塞 ingress 的 API key。** ingress 的鉴权是 source key，那是"服务端到
 *    服务端"的凭据；打进分发给终端的扩展里，等于把写入权发到每台机器上，**吊销一次全员
 *    停摆，审计粒度只到「源」而不到「人」**。插件要用的是使用者自己的会话身份——可审计、
 *    可按人吊销，这也才对得上"选插件而不选无头"的那条理由（真人真会话）。
 *
 * 来源：本文件是 wavely `erp/client/plugin/lib/rpc.js`（源头，含 2026-07-27 实测）与
 * steward `client/plugin/lib/rpc.js`（抄自前者，补了上面那条 🔴）的合并版，上收进框架
 * 以终止第三份拷贝。相对两个原版唯一的行为变化见下方 `reauth`。
 */

/**
 * 值得重试的错误码。
 * -32029 限流 · -32006/-32007 服务暂时不可用 · -32099 本文件把网络层失败归一化成的码。
 */
const TRANSIENT = [-32029, -32006, -32007, -32099];

/**
 * 网络层失败的自重试次数（总尝试 = 本值 + 1）。
 *
 * 定成 2 有实测依据（wavely 2026-07-27 实测线上 Router）：连打五次**两次直接连接失败**，
 * 成功的也要 3.4~6.1 秒（1 vCPU + 本机代理链路）。按 ~40% 失败率算，只重试一次仍有约
 * 16% 整体失败，三次尝试能压到 6% 左右。代价是最坏多等十几秒——对登录来说，等一会儿
 * 远好过直接失败。
 */
const NETWORK_RETRIES = 2;

/** 外层退避重试的上限（TRANSIENT 类）。 */
const TRANSIENT_RETRIES = 5;

export class RpcError extends Error {
    constructor(code, message) {
        super(`[${code}] ${message}`);
        this.name = 'RpcError';
        this.code = code;
    }
}

/** -32001 = 会话失效/未认证。单独导出，省得每个项目自己记这个数字。 */
export const UNAUTHENTICATED = -32001;

export async function sha256(text) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object}   deps
 * @param {function} deps.getEndpoint  () => Promise<string>  Router 端点（见 endpoints.js）
 * @param {function} deps.getToken     () => Promise<string|undefined>
 * @param {function} deps.setToken     (token) => Promise<void>
 * @param {function} [deps.reauth]     () => Promise<void>  会话失效时重新拿 token；拿不到就抛
 * @param {function} [deps.fetchImpl]  注入点，仅供测试；缺省用全局 fetch
 *
 * @why `reauth` 取代了两个原版里写死的 `getCredentials()` → `login(name, password)`。
 *      泛化的收益很具体：**passport 设备线（`user.passport.verify`，设备令牌换 24h 会话）
 *      能直接插进来，不用改本文件**。两个原版都把"重登"钉死成"拿存着的明文密码再登一次"，
 *      于是每台运营机器上都留着一份明文密码——而框架里本来就有一条不需要存密码的路。
 *      要保持原样行为，用 `createPasswordAuth()` 造这个 reauth 即可（见下）。
 */
export function createRpc({ getEndpoint, getToken, setToken, reauth, fetchImpl }) {
    const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));

    /**
     * 单次请求，只处理**网络层**失败。
     *
     * @why fetch 在网络层失败时抛的是 `TypeError: Failed to fetch`，**没有 code**，
     *      外层 call() 的 TRANSIENT 判断完全接不住它——一次抖动就把整条调用打死。
     *      统一转成 -32099（已在 TRANSIENT 名单里），并且自己先快重试：
     *      login 走的是 raw 不经 call，没有这一层它就完全没有重试。
     */
    async function raw(method, params, token, retry = NETWORK_RETRIES) {
        let res;
        try {
            res = await doFetch(await getEndpoint(), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
            });
        } catch (e) {
            if (retry > 0) {
                // 退避 800ms → 1600ms。实测单次连接就要 3~6 秒，退避太短等于在链路还没
                // 缓过来时白撞一次。
                await sleep(800 * (NETWORK_RETRIES - retry + 1));
                return raw(method, params, token, retry - 1);
            }
            throw new RpcError(-32099,
                `网络请求失败（${e && e.message}）——检查网络/代理，或确认 Router 地址可达`);
        }
        if (!res.ok) throw new RpcError(-32099, `Router HTTP ${res.status}`);
        const { result, error } = await res.json();
        if (error) throw new RpcError(error.code, error.message);
        return result;
    }

    /**
     * 带重登与退避的调用。**写操作全部经这里。**
     *
     * ⚠️ 这里的自动重试对**非幂等**方法是危险的：一次网络抖动可能变成两次写入。
     *    经验做法是让写方法自带幂等键（ingress 的 `request_id`、实体的业务唯一键），
     *    这也正是 queue.js 强制要 `idemKey` 的原因——两处是同一条纪律。
     */
    async function call(method, params) {
        for (let attempt = 0; ; attempt++) {
            try {
                return await raw(method, params, await getToken());
            } catch (e) {
                if (e.code === UNAUTHENTICATED && attempt === 0 && reauth) {
                    await reauth();          // 拿不到新会话就让它自己抛，别吞成通用失败
                    continue;
                }
                if (TRANSIENT.includes(e.code) && attempt < TRANSIENT_RETRIES) {
                    await sleep(1500 * (attempt + 1));
                    continue;
                }
                throw e;
            }
        }
    }

    /**
     * 挑战响应登录（内部员工账号）。成功后 token 只留在 background，不进页面进程。
     * @why 留在 kit 里是因为派生过来的两个插件都要它，且 salt/challenge 的派生方式
     *      写错了症状是"密码错"——最容易怀疑到无关的地方去。
     */
    async function login(name, password, deviceId) {
        const { challenge, salt } = await raw('user.login.request', { name });
        if (!salt) throw new RpcError(-32000, 'login.request 未回传 salt，无法派生 hash');
        const hash = await sha256(password + salt);
        const response = await sha256(challenge + hash);
        const out = await raw('user.login.verify', { name, challenge, response, deviceId });
        await setToken(out.token);
        return out;
    }

    return { call, raw, login, sha256 };
}

/**
 * 把「存着的账号密码」包成一个 `reauth` —— 等价于两个原版插件的既有行为，迁移用。
 *
 * @why 单独拿出来，是为了让"我们在每台机器上存了明文密码"变成一处**显式的选择**，
 *      而不是藏在 rpc.js 的重登分支里。想改用 passport 设备线时，换掉这一个函数即可。
 * @why 认证类失败才清凭据：网络抖动清掉的话，一次断网就把用户的「记住密码」抹了。
 */
export function createPasswordAuth({ rpc, getCredentials, clearCredentials, deviceId }) {
    return async function reauth() {
        const cred = await getCredentials();
        if (!cred) throw new RpcError(UNAUTHENTICATED, '登录已过期，请在插件弹窗重新登录');
        try {
            await rpc.login(cred.name, cred.password, deviceId);
        } catch (e) {
            if (e.code === UNAUTHENTICATED || e.code === -32002) {
                if (clearCredentials) await clearCredentials();
                throw new RpcError(UNAUTHENTICATED, `自动登录失败（${e.message}）——保存的凭据已失效并清除，请重新登录`);
            }
            throw e;    // 网络类：留着凭据，下次再试
        }
    };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
