/**
 * 会话与凭据的存放策略 —— token 存哪一层、要不要留密码，收在这一个文件里。
 *
 * ## 「记住密码」到底做了什么（wavely 的既有语义，原样保留）
 * - **勾上** = 凭据存 `chrome.storage.local`（本机，不上传），**且 token 也存 local**
 *   —— 关浏览器再开不必重登。密码本就在 local 了，token 只是短期凭据，放同一层不会更弱，
 *   换来的是少受一次登录之苦（走代理访问线上 Router 单次要 5 秒以上）。
 * - **不勾** = token 存 `chrome.storage.session`，**关浏览器即失效**，维持"不留痕"的预期。
 *
 * ## 🔴 但这条策略的前提，框架里其实可以不成立
 * "必须留一份明文密码才能自动重登"——三个派生插件都这么做了，于是每台运营机器上都躺着
 * 一份明文密码。而 SOLO 的 **passport 设备线**（`user.passport.device.issue` 换设备令牌，
 * `user.passport.verify` 用设备令牌换 24h 会话）本来就是为外部客户端设计的：
 * 令牌可按人吊销、`$owner` 自动行隔离，**全程不需要存密码**。
 * 实扫三个派生插件（wavely / steward / trend）对 `user.passport.*` 的引用数是 **0**
 * ——不是它们选错了，是这条路没人知道。
 *
 * 所以这里把凭据抽象成 `credentials`（一个不透明对象），`rpc.createPasswordAuth` 只是
 * 其中一种消费方式。要迁到设备令牌，存 `{ anchor, deviceId, deviceToken }` 即可，
 * 本文件一行不用改。
 */

const TOKEN_KEY = 'token';
const CRED_KEY = 'credentials';
const REMEMBER_KEY = 'remember';

/**
 * @param {object} opts
 * @param {object} opts.local    持久后端（chromeArea('local')）
 * @param {object} opts.session  会话后端（chromeArea('session')）；缺省退化为 local
 */
export function createSession({ local, session }) {
    const volatile = session || local;

    /**
     * @why 每次都现读 remember 而不是缓存：popup 里改了勾选、background 那边若还拿着
     *      旧值，就会把 token 写进另一层——症状是"明明勾了记住，重开还要登"，
     *      而两边各自看都"正常"。
     */
    const isRemembered = async () => Boolean(await local.get(REMEMBER_KEY));
    const tokenArea = async () => ((await isRemembered()) ? local : volatile);

    return {
        isRemembered,

        /** 切换「记住」。关掉时**立刻**把凭据与持久 token 清掉，别留残留。 */
        async setRemember(on) {
            await local.set(REMEMBER_KEY, Boolean(on));
            if (!on) {
                await local.remove(CRED_KEY);
                await local.remove(TOKEN_KEY);
            }
        },

        async getToken() {
            return (await (await tokenArea()).get(TOKEN_KEY));
        },

        async setToken(token) {
            // 写之前先清另一层，否则切换 remember 时会留下一个过期的影子 token，
            // 下次读到它就是一次莫名其妙的 -32001。
            const area = await tokenArea();
            const other = area === local ? volatile : local;
            await other.remove(TOKEN_KEY);
            await area.set(TOKEN_KEY, token);
        },

        async clearToken() {
            await local.remove(TOKEN_KEY);
            await volatile.remove(TOKEN_KEY);
        },

        /** 不透明凭据：账号密码、或设备令牌，由项目决定放什么。 */
        async getCredentials() { return await local.get(CRED_KEY); },
        async setCredentials(cred) {
            if (cred == null) return local.remove(CRED_KEY);
            return local.set(CRED_KEY, cred);
        },
        async clearCredentials() { return local.remove(CRED_KEY); },

        /** 退出登录：token 与凭据一并清掉。 */
        async logout() {
            await local.remove(TOKEN_KEY);
            await volatile.remove(TOKEN_KEY);
            await local.remove(CRED_KEY);
        },
    };
}
