/**
 * Popup —— 只做 UI 与消息转发，**不碰 token、不发 Router 请求**（那些全在 background）。
 *
 * 🔴 禁止 alert/confirm/prompt（SOLO UI 规范）：反馈一律写进 #msg。
 */
const $ = (id) => document.getElementById(id);
const send = (type, payload) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!res) return reject(new Error('background 无响应（service worker 可能刚被回收，重试一次）'));
        res.error ? reject(new Error(res.error)) : resolve(res.data);
    });
});

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
