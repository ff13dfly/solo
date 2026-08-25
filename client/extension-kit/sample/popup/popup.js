/**
 * Popup —— 只做 UI 与消息转发，**不碰 token、不发 Router 请求**（那些全在 background）。
 *
 * 🔴 禁止 alert/confirm/prompt（SOLO UI 规范）：反馈一律写进 #msg。
 */
// 只引 messaging 这一个模块，**不经 `kit.js`**：那会把 rpc / queue / image 一并拉进
// popup 的进程，而 popup 按设计不该碰它们（见上面那段）。ESM 没有摇树，import 谁谁就求值。
import '../kit/messaging.js';
const { callBackground } = globalThis.SoloMessaging;

const $ = (id) => document.getElementById(id);

/**
 * 🔴 **别裸调 `chrome.runtime.sendMessage`。** MV3 的 service worker 空闲即被回收，
 *    冷启动瞬间那一发会 reject——裸调让异常冒泡出去，把**后面整段 UI 代码**带走，
 *    症状是"点了没反应、也没有报错"，排查成本极高。
 *
 * `callBackground` 永不抛：瞬时错误自己退避重试，最后归一成 `{ok:false,error}`。
 * 这里再转成 reject，是因为下面每个入口都套着 `guard()`，抛出即显示到 #msg。
 */
const send = async (type, payload) => {
    const r = await callBackground(type, payload);
    if (!r.ok) throw new Error(r.error);
    return r.data;
};

const say = (text, isErr = false) => { $('msg').textContent = text; $('msg').className = isErr ? 'err' : ''; };
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { say(e.message, true); } };

async function refresh() {
    const { items, current } = await send('LIST_ENDPOINTS');
    $('endpoint').innerHTML = '';
    for (const e of items) {
        const o = document.createElement('option');
        o.value = e.url; o.textContent = e.name; o.selected = e.url === current;
        $('endpoint').append(o);
    }
    const st = await send('AUTH_STATE');
    $('login-box').hidden = st.loggedIn;
    $('ready-box').hidden = !st.loggedIn;
    if (st.loggedIn) await stats();
}

async function stats() {
    const s = await send('QUEUE_STATS');
    $('stats').textContent = `队列 ${s.pending}（到期 ${s.due}）· 死信 ${s.dead.length}`;
}

$('endpoint').addEventListener('change', guard(async (e) => {
    await send('SET_ENDPOINT', { url: e.target.value });
    say('已切换 Router，需要重新登录');
    await refresh();
}));

$('login').addEventListener('click', guard(async () => {
    say('登录中…');
    await send('LOGIN', { name: $('name').value.trim(), password: $('password').value, remember: $('remember').checked });
    say('登录成功');
    await refresh();
}));

$('logout').addEventListener('click', guard(async () => { await send('LOGOUT'); say(''); await refresh(); }));

$('capture').addEventListener('click', guard(async () => {
    say('采集中…');
    const r = await send('CAPTURE', { method: $('method').value.trim() });
    // duplicate 不是失败：同一页当天已经采过，服务端也会按 idemKey 去重。
    say(r.duplicate ? `已采过（idemKey ${r.idemKey}…），未重复入队`
                    : `已入队 ${r.idemKey}… · 本轮送出 ${r.drained.sent}`);
    await stats();
}));

$('drain').addEventListener('click', guard(async () => {
    const s = await send('QUEUE_DRAIN');
    say(`送出 ${s.sent} · 失败 ${s.failed} · 死信 ${s.dead} · 剩 ${s.remaining}`);
    await stats();
}));

// 存过的方法名留着，省得每次重填
$('method').addEventListener('change', () => chrome.storage.local.set({ sampleMethod: $('method').value }));
chrome.storage.local.get('sampleMethod').then(({ sampleMethod }) => { if (sampleMethod) $('method').value = sampleMethod; });

refresh().catch((e) => say(e.message, true));
