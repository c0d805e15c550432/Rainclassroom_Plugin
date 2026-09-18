const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const id = '1774242362959461010';
const lesson = '1774242215168965248';
function storage() {
    const map = new Map();
    return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) };
}
function doc() {
    const listeners = new Map();
    return { cookie: '', body: null, readyState: 'loading', querySelectorAll: () => [], getElementById: () => null,
        addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
        createEvent() { return { initCustomEvent(type, b, c, detail) { this.type = type; this.detail = detail; } }; },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
    };
}
function harness(options = {}) {
    let now = 1800000000000;
    let serial = 0;
    const timers = new Map();
    const requests = [];
    const posts = [];
    const window = { console, URL, URLSearchParams, Blob, ArrayBuffer, TextDecoder, crypto: webcrypto,
        Date: class extends Date { static now() { return now; } },
        setTimeout(fn, delay) { const token = ++serial; timers.set(token, { fn, when: now + delay }); return token; },
        clearTimeout(token) { timers.delete(token); }, setInterval() {},
        navigator: { locks: options.locks || { request: async (key, fn) => fn() } },
        location: new URL('https://pro.yuketang.cn/lesson/student/v3/' + lesson),
        document: options.document || doc(), localStorage: options.storage || storage(), sessionStorage: storage(),
        addEventListener() {},
        GM_xmlhttpRequest(request) { requests.push(request); return { abort() { request.onabort?.(); } }; },
        request: { post: async (url, body) => { posts.push({ url, body }); return { code: 0 }; } },
    };
    window.window = window;
    window.top = options.top || window;
    vm.createContext(window);
    vm.runInContext(source.replace('    init();', `window.api = {
        captureQuestionSlides, processQuizSocket, receiveQuizEvent, setupQuizBridge, setupFrameListener,
        setupFrameRelay, setupQuizSocket, recoverQuizPage, observeAnswerRequest, quizQuestions, localQuestions,
        applyQuizSettings, validateQuizSettings, parseAIAnswer, randomChoices, aiEndpoint, claimQuizAttempt,
        submitQuizAnswer, quizKey, frameId, IS_TOP_WINDOW,
        settings: () => quizSettings, page: PAGE_WINDOW,
    };`), window);
    const api = window.api;
    const capture = (overrides = {}) => api.captureQuestionSlides({ data: { slides: [{
        id, cover: 'https://fe-static-yuketang.yuketang.cn/example.jpg',
        problem: { problemId: id, problemType: 1, body: '测试题', result: null,
            options: [{ key: 'A', value: '是' }, { key: 'B', value: '否' }], ...overrides },
    }] } });
    const unlock = (overrides = {}) => api.processQuizSocket({ op: 'unlockproblem', lessonid: lesson,
        problem: { prob: id, sid: id, dt: now, limit: -1, ...overrides } });
    const advance = async ms => {
        now += ms;
        for (const [token, t] of [...timers]) if (t.when <= now && timers.has(token)) { timers.delete(token); t.fn(); }
        await flush();
    };
    return { ...api, window, requests, posts, timers, capture, unlock, advance,
        now: () => now, q: () => api.quizQuestions.get(api.quizKey(lesson, id)) };
}
function enable(h, values = {}) {
    h.applyQuizSettings({ enabled: true, mode: 'random', delay: 3, timeout: 20, safety: 3,
        apiKey: 'test-key', baseURL: 'https://ai.example/v1', model: 'test-model', images: false, ...values });
}
function answer(h, value = '{"answer":["B"],"explanation":"理由"}') {
    const request = h.requests.find(r => r.method === 'POST');
    request.onload({ status: 200, responseText: JSON.stringify({ choices: [{ message: { content: value } }] }) });
}

test('disabled by default: deck and live question cause neither AI requests nor submissions', async () => {
    const h = harness(); h.capture(); h.unlock(); await h.advance(60000);
    assert.equal(h.posts.length, 0); assert.equal(h.requests.length, 0);
});
test('slides alone never activate unpublished or historical questions', async () => {
    const h = harness(); enable(h); h.capture(); await h.advance(60000);
    assert.equal(h.quizQuestions.size, 0); assert.equal(h.posts.length, 0);
});
test('random answer uses actual two options and exact submission schema after configured delay', async () => {
    const h = harness(); enable(h); h.capture(); h.unlock();
    await h.advance(2999); assert.equal(h.posts.length, 0);
    await h.advance(1); assert.equal(h.posts.length, 1);
    const { body, url } = h.posts[0];
    assert.equal(url, '/api/v3/lesson/problem/answer');
    assert.equal(body.problemId, id); assert.equal(body.problemType, 1);
    assert.equal(body.dt, h.now()); assert.ok(['A', 'B'].includes(body.result[0]));
    assert.match(h.q().status, /提交成功/);
});
test('question arriving before deck is activated after slide response; duplicate messages do not reset delay', async () => {
    const h = harness(); enable(h); h.unlock(); await h.advance(1000); h.capture();
    await h.advance(2000); h.unlock(); await h.advance(1000);
    assert.equal(h.posts.length, 1);
});
test('AI display emits compatible anonymous request, shows result and never submits, even at deadline', async () => {
    const h = harness(); enable(h, { mode: 'ai-display' }); h.capture(); h.unlock({ limit: 5 });
    await flush();
    assert.equal(h.requests.length, 1);
    const r = h.requests[0];
    assert.equal(r.url, 'https://ai.example/v1/chat/completions'); assert.equal(r.anonymous, true);
    assert.equal(r.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(r.data).stream, false);
    assert.ok(!r.data.includes(lesson)); assert.ok(!r.data.includes(id));
    answer(h); await flush(); await h.advance(40000);
    assert.equal(h.q().answer.choices[0], 'B'); assert.equal(h.posts.length, 0);
});
test('AI automatic answer submits once and cancels timeout fallback', async () => {
    const h = harness(); enable(h, { mode: 'ai-auto' }); h.capture(); h.unlock();
    await flush(); answer(h); await flush(); await h.advance(21000);
    assert.equal(h.posts.length, 1); assert.deepEqual(Array.from(h.posts[0].body.result), ['B']);
});
test('AI timeout falls back exactly once; late response cannot submit again', async () => {
    const h = harness(); enable(h, { mode: 'ai-auto', timeout: 2 }); h.capture(); h.unlock();
    await flush(); await h.advance(2000); answer(h); await flush();
    assert.equal(h.posts.length, 1); assert.match(h.q().status, /随机兜底/);
});
test('deadline safety overrides both a long random delay and a long AI timeout', async () => {
    for (const mode of ['random', 'ai-auto']) {
        const h = harness(); enable(h, { mode, delay: 60, timeout: 60, safety: 3 }); h.capture(); h.unlock({ limit: 10 });
        await h.advance(6999); assert.equal(h.posts.length, 0);
        await h.advance(1); assert.equal(h.posts.length, 1);
    }
});
test('server now corrects clock skew and teacher extension reschedules fallback', async () => {
    const h = harness(); enable(h, { delay: 60 }); h.capture(); h.unlock({ dt: h.now() - 120000, now: h.now() - 115000, limit: 15 });
    assert.equal(h.q().deadline, h.now() + 10000);
    h.processQuizSocket({ op: 'extendtime', lessonid: lesson, problem: { prob: id, dt: h.now(), now: h.now(), limit: 30, extend: 20 } });
    await h.advance(7000); assert.equal(h.posts.length, 0);
    await h.advance(20000); assert.equal(h.posts.length, 1);
});
test('teacher close, manual answer and disabling each cancel a pending submission', async () => {
    for (const stop of [h => h.processQuizSocket({ op: 'problemfinished', lessonid: lesson, prob: id }),
        h => h.observeAnswerRequest('/api/v3/lesson/problem/answer', JSON.stringify({ problemId: id })),
        h => h.applyQuizSettings({ ...h.settings(), enabled: false })]) {
        const h = harness(); enable(h, { mode: 'ai-auto' }); h.capture(); h.unlock();
        await flush(); stop(h); answer(h); await h.advance(30000); assert.equal(h.posts.length, 0);
    }
});
test('switching to display while a cross-tab claim is waiting prevents submission', async () => {
    let unlock;
    const h = harness({ locks: { request: () => new Promise(resolve => { unlock = resolve; }) } });
    enable(h, { delay: 0 }); h.capture(); h.unlock(); await h.advance(0);
    enable(h, { mode: 'ai-display' }); unlock(true); await flush(); assert.equal(h.posts.length, 0);
});
test('expired, answered and unsupported questions never submit', async () => {
    for (const options of [{ problemType: 5 }, { result: ['A'] }, { expired: true }]) {
        const h = harness(); enable(h); h.capture(options); h.unlock({ limit: options.expired ? 0 : -1 });
        await h.advance(60000); assert.equal(h.posts.length, 0);
    }
});
test('malformed AI prose and invalid choices are rejected; multiple choice result is nonempty', () => {
    const h = harness(); h.capture(); h.unlock();
    for (const text of ['The word A appears, but B is possible', '{"answer":["C"]}', '{"answer":["A","B"]}', '{"answer":["A","A"]}']) {
        assert.throws(() => h.parseAIAnswer(text, h.q()));
    }
    assert.equal(h.parseAIAnswer('```json\n{"answer":["A"]}\n```', h.q()).choices[0], 'A');
    for (let i = 0; i < 100; i++) assert.ok(h.randomChoices({ ...h.q(), type: 2 }).length > 0);
});
test('provider configuration validates API credentials and URL without leaking the key in errors', () => {
    const h = harness();
    assert.throws(() => enable(h, { mode: 'ai-auto', apiKey: '' }), /API Key/);
    assert.throws(() => h.aiEndpoint('https://key@example.com/v1'));
    assert.throws(() => h.aiEndpoint('http://example.com/v1'));
    assert.equal(h.aiEndpoint('http://127.0.0.1:8080/v1/'), 'http://127.0.0.1:8080/v1/chat/completions');
    assert.equal(h.aiEndpoint('https://example.com/v1/chat/completions'), 'https://example.com/v1/chat/completions');
});
test('same question in two top-level tabs claims once', async () => {
    const shared = storage();
    const a = harness({ storage: shared }), b = harness({ storage: shared });
    for (const h of [a, b]) { enable(h); h.capture(); h.unlock(); }
    await Promise.all([a.advance(3000), b.advance(3000)]);
    assert.equal(a.posts.length + b.posts.length, 1);
});
test('iframe forwards question to one coordinator and submits through the originating frame', async () => {
    const top = harness(); const child = harness({ top: top.window });
    top.setupFrameListener(); top.setupQuizBridge(); child.setupFrameRelay(); child.setupQuizBridge();
    enable(top); child.capture(); child.unlock();
    assert.equal(top.quizQuestions.size, 1); assert.equal(child.quizQuestions.size, 0);
    await top.advance(3000);
    assert.equal(top.posts.length, 0); assert.equal(child.posts.length, 1);
    assert.match(top.q().status, /提交成功/);
});
test('failed or ambiguous submission is not retried on duplicate capture', async () => {
    const h = harness(); let count = 0;
    h.window.request.post = async () => { count++; throw new Error('private response content'); };
    enable(h); h.capture(); h.unlock(); await h.advance(3000);
    h.unlock(); h.capture(); await h.advance(30000);
    assert.equal(count, 1); assert.match(h.q().status, /不会自动重试/);
    assert.ok(!h.q().status.includes('private'));
});
test('reconnect ignores historical questions and only restores current unlocked question', () => {
    const h = harness(); h.capture();
    const history = [{ type: 'problem', prob: id, dt: h.now(), limit: -1 }];
    h.processQuizSocket({ op: 'hello', lessonid: lesson, slideid: 'other', timeline: history, unlockedproblem: [id] });
    assert.equal(h.quizQuestions.size, 0);
    h.processQuizSocket({ op: 'hello', lessonid: lesson, slideid: id, timeline: history, unlockedproblem: [id] });
    assert.equal(h.quizQuestions.size, 1);
});

test('AI display can show a response after the deadline without submitting', async () => {
    const h = harness(); enable(h, { mode: 'ai-display' }); h.capture(); h.unlock({ limit: 5 });
    await h.advance(6000); answer(h); await flush();
    assert.equal(h.q().answer.choices[0], 'B'); assert.equal(h.posts.length, 0);
});
test('AI display failure and timeout never trigger random fallback', async () => {
    for (const fail of [h => h.requests[0].onload({ status: 429 }), h => h.advance(21000)]) {
        const h = harness(); enable(h, { mode: 'ai-display' }); h.capture(); h.unlock();
        await flush(); await fail(h); await flush();
        assert.equal(h.posts.length, 0); assert.match(h.q().status, /失败|超时/);
    }
});
test('AI invalid answer causes random fallback in automatic mode only', async () => {
    const h = harness(); enable(h, { mode: 'ai-auto' }); h.capture(); h.unlock();
    await flush(); answer(h, '{"answer":["Z"]}'); await flush();
    assert.equal(h.posts.length, 1); assert.ok(['A', 'B'].includes(h.posts[0].body.result[0]));
});
test('unknown image host prevents sending a key or signed URL to any provider', async () => {
    const h = harness(); enable(h, { mode: 'ai-display', images: true }); h.capture(); h.unlock();
    h.q().image = 'https://unrelated.example/image?auth=private';
    h.applyQuizSettings(h.settings());
    await flush();
    assert.equal(h.requests.filter(r => r.method === 'POST').length, 0);
    assert.ok(h.requests.every(r => !r.headers?.Authorization));
});
test('WebSocket interception handles the real message shape, ignores unrelated sockets and cancels on close', async () => {
    class Socket extends EventTarget { constructor(url) { super(); this.url = url; } }
    const h = harness(); h.window.WebSocket = Socket; h.setupQuizSocket(); enable(h); h.capture();
    const other = new h.window.WebSocket('wss://other.example/wsapp/');
    const data = JSON.stringify({ op: 'unlockproblem', lessonid: lesson, problem: { prob: id, dt: h.now(), limit: -1 } });
    other.dispatchEvent(new MessageEvent('message', { data })); await flush();
    assert.equal(h.quizQuestions.size, 0);
    const socket = new h.window.WebSocket('wss://pro.yuketang.cn/wsapp/');
    assert.ok(socket instanceof Socket);
    socket.dispatchEvent(new MessageEvent('message', { data })); await flush();
    assert.equal(h.quizQuestions.size, 1);
    socket.dispatchEvent(new Event('close')); await h.advance(5000);
    assert.equal(h.posts.length, 0);
});
test('background timer waking after deadline never submits an expired question', async () => {
    const h = harness(); enable(h); h.capture(); h.unlock({ limit: 10 });
    await h.advance(60000); assert.equal(h.posts.length, 0);
});
test('changing lesson cancels the prior lesson question', async () => {
    const h = harness(); enable(h); h.capture(); h.unlock();
    h.processQuizSocket({ op: 'hello', lessonid: 'another-lesson', timeline: [] });
    await h.advance(5000); assert.equal(h.posts.length, 0);
});
test('manual submission marks shared ledger so another tab skips automatic submission', async () => {
    const shared = storage(); const a = harness({ storage: shared }), b = harness({ storage: shared });
    for (const h of [a, b]) { enable(h); h.capture(); h.unlock(); }
    a.observeAnswerRequest('/api/v3/lesson/problem/answer', JSON.stringify({ problemId: id }));
    await flush(); await b.advance(3000); assert.equal(b.posts.length, 0);
});

test('late Vue recovery respects completed and expired exercise state before starting AI', async () => {
    for (const state of [{ isComplete: true }, { timeOver: true }]) {
        const document = doc();
        const problem = { problemId: id, problemType: 1, body: '恢复测试', result: null,
            options: [{ key: 'A', value: '是' }, { key: 'B', value: '否' }] };
        const root = { lessonID: lesson, problemMap: new Map([[id, { problem }]]) };
        root.$children = [{ problemID: id, oProblem: problem, summary: {}, limit: -1, leaveTime: 0,
            $parent: root, ...state }];
        document.querySelectorAll = selector => selector === '#app' ? [{ __vue__: root }] : [];
        const h = harness({ document }); enable(h, { mode: 'ai-auto' }); h.recoverQuizPage();
        await h.advance(30000); assert.equal(h.posts.length, 0); assert.equal(h.requests.length, 0);
    }
});
test('multi-select AI submits the selected keys in sorted order', async () => {
    const h = harness(); enable(h, { mode: 'ai-auto' }); h.capture({ problemType: 2 }); h.unlock();
    await flush(); answer(h, '{"answer":["B","A"]}'); await flush();
    assert.equal(h.posts.length, 1); assert.equal(h.posts[0].body.problemType, 2);
    assert.deepEqual(Array.from(h.posts[0].body.result), ['A', 'B']);
});
