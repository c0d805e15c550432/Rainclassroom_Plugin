const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
const stateKey = 'rc_downloader_state';
function memoryStorage() {
    const data = new Map();
    return {
        getItem: key => data.get(key) ?? null,
        setItem: (key, value) => data.set(key, String(value)),
        removeItem: key => data.delete(key),
    };
}
function locks() {
    let tail = Promise.resolve();
    return { request: (_key, fn) => {
        const result = tail.then(fn);
        tail = result.catch(() => {});
        return result;
    } };
}
function testDocument() {
    const listeners = new Map();
    return {
        body: null, cookie: '', readyState: 'loading', getElementById: () => null, querySelectorAll: () => [],
        addEventListener(type, fn) { listeners.set(type, [...(listeners.get(type) || []), fn]); },
        createEvent() { return { initCustomEvent(type, _bubbles, _cancelable, detail) { this.type = type; this.detail = detail; } }; },
        dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); return true; },
    };
}
function harness(options = {}) {
    const listeners = new Map();
    const intervals = [];
    const window = {
        console, Blob, URL, URLSearchParams, crypto: webcrypto, setTimeout, clearTimeout,
        setInterval: fn => intervals.push(fn),
        location: new URL('https://pro.yuketang.cn/v2/web/index'),
        navigator: { userAgent: 'test', locks: options.locks || locks() },
        document: options.document || testDocument(),
        localStorage: options.storage || memoryStorage(), sessionStorage: memoryStorage(),
        GM_xmlhttpRequest: options.request || (() => { throw new Error('Unexpected network request'); }),
        GM_download: options.download,
        GM_info: { downloadMode: options.downloadMode || 'browser' },
        showSaveFilePicker: options.picker,
        PerformanceObserver: options.performanceObserver,
        // Tiny codec stubs keep export integration tests dependency-free.
        FileReader: class {
            async readAsDataURL(blob) { this.result = await blob.text(); this.onloadend(); }
        },
        Image: class {
            width = 960; height = 540;
            set src(_value) { setImmediate(() => this.onload()); }
        },
        jspdf: { jsPDF: class {
            pages = [];
            addPage() {}
            addImage(data) { this.pages.push(data); }
            output() { return new Blob(['PDF:', ...this.pages], { type: 'application/pdf' }); }
        } },
        addEventListener: (type, fn) => listeners.set(type, fn),
    };
    window.window = window;
    window.top = options.top || window;
    if (options.pageWindow) {
        window.unsafeWindow = options.pageWindow;
        window.top = options.pageWindow.top;
        options.pageWindow.document ||= window.document;
    }
    vm.createContext(window);
    vm.runInContext(source.replace('    init();', `
        window.testApi = { CONFIG, STATE, loadState, saveSelection, reloadStateAndUI,
            addPendingItem, mutateState, selectAll, onDownloadSelected, onClearAll,
            runPool, downloadCovers, downloadVideo, processApiResponse, handleFetch,
            isVideoUrl, isLoginUrl, isLoginScreen, setupFrameListener, setupFrameRelay, withDownloadSlot,
            IS_TOP_WINDOW, apiEndpoint, setupFetchInterceptor, setupXHRInterceptor, setupVideoInterceptor,
            rescanCurrentDocument, handleVideoUrl, checkVideoElement,
            setupResourceRecovery, handleLessonInfo,
            getCoursewareStatus: () => coursewareStatus,
            getEarlyLogs: () => earlyLogs,
            executeOneJob, retainFile, queueFileSave, saveFileAs, warnBeforeLeaving,
            whenSavesSettle: () => saveQueue,
            setExecutor(fn) { executeOneJob = fn; }, window };
    `), window);
    Object.assign(window.testApi.CONFIG, { RETRY_BACKOFF_MS: 1, MAX_RETRIES: 1, SAVE_TIMEOUT_MS: 2000 });
    return { ...window.testApi, listeners, intervals, storage: window.localStorage };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
const payload = { data: { slides: [{ index: 1, cover: 'https://example.test/1.jpg' }] } };

test('capture accepts both real lesson-info routes and trailing slashes', () => {
    const h = harness();
    assert.equal(h.apiEndpoint('/api/v3/classroom-report/lesson-info?lesson_id=1'), h.CONFIG.LESSON_INFO_URL);
    assert.equal(h.apiEndpoint('/api/v3/classroom-report/student/lesson-info/'), h.CONFIG.LESSON_INFO_URL);
});

test('a userscript window wrapper does not turn the real top page into a child frame', () => {
    const page = { postMessage() {} };
    page.top = page;
    const h = harness({ pageWindow: page });
    assert.equal(h.IS_TOP_WINDOW, true);
});

test('fetch interception observes the page realm even when sandbox fetch is separate', async () => {
    const page = { fetch: async () => new Response(JSON.stringify(payload)), postMessage() {} };
    page.top = page;
    const h = harness({ pageWindow: page });
    h.setupFetchInterceptor();
    await page.fetch(h.CONFIG.FETCH_URL);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(h.STATE.pendingItems.length, 1);
});

test('XHR interception observes page-realm JSON responses and safely handles reused XHR objects', async () => {
    class XHR {
        constructor() { this.listeners = []; this.responseType = 'json'; }
        addEventListener(_type, fn) { this.listeners.push(fn); }
        open(_method, url) { this.url = url; }
        send() { for (const fn of this.listeners) fn(); }
    }
    const page = { XMLHttpRequest: XHR }; page.top = page;
    const h = harness({ pageWindow: page });
    h.setupXHRInterceptor();
    const xhr = new page.XMLHttpRequest();
    xhr.open('GET', h.CONFIG.FETCH_URL);
    xhr.response = payload;
    xhr.send();
    await tick();
    assert.equal(h.STATE.pendingItems.length, 1);
    xhr.open('GET', '/unrelated');
    xhr.response = { data: { slides: payload.data.slides, activityId: 'unrelated', title: 'Wrong endpoint' } };
    xhr.send();
    await tick();
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(xhr.listeners.length, 1);
});

test('page-realm media src setter captures video without changing normal setter behavior', async () => {
    class Media { get src() { return this.value; } set src(value) { this.value = value; } }
    const page = { HTMLMediaElement: Media }; page.top = page;
    const h = harness({ pageWindow: page });
    h.setupVideoInterceptor();
    const media = new page.HTMLMediaElement();
    media.src = '//ks-playback.xuetangx.com/liveRecordLive/test.mp4';
    await tick();
    assert.equal(media.src, '//ks-playback.xuetangx.com/liveRecordLive/test.mp4');
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(h.STATE.pendingItems[0].type, 'video');
    assert.equal(h.STATE.pendingItems[0].source, 'https://ks-playback.xuetangx.com/liveRecordLive/test.mp4');
});

test('late injection recovers existing video and only replays observed allowlisted read APIs', async () => {
    const api = 'https://pro.yuketang.cn/api/v3/lesson/presentation/fetch?activity_id=42';
    const video = 'https://ks-playback.xuetangx.com/liveRecordLive/already-loaded.mp4';
    const calls = [];
    const doc = testDocument();
    doc.querySelectorAll = selector => selector === 'video'
        ? [{ currentSrc: 'blob:old', src: video, querySelectorAll: () => [] }] : [];
    const page = { performance: { getEntriesByType: () => [
        { name: api }, { name: api },
        { name: 'https://evil.test/api/v3/lesson/presentation/fetch' },
        { name: 'https://pro.yuketang.cn/api/v3/lesson/delete' },
    ] } }; page.top = page;
    const h = harness({ document: doc, pageWindow: page, request: options => {
        calls.push(options.url);
        setImmediate(() => options.onload({ status: 200, responseText: JSON.stringify(payload) }));
    } });
    await h.rescanCurrentDocument();
    await tick();
    assert.deepEqual(calls, [api]);
    assert.equal(h.STATE.pendingItems.length, 2);
    assert.ok(h.STATE.pendingItems.some(item => item.type === 'video'));
    assert.ok(h.STATE.pendingItems.some(item => item.type === 'ppt'));
    await h.rescanCurrentDocument();
    assert.deepEqual(calls, [api]);
});

test('a sandbox denying Web Locks still captures resources without an unhandled rejection', async () => {
    const h = harness({ locks: { request: () => Promise.reject(new Error('SecurityError')) } });
    await h.addPendingItem('Available', payload, {}, 'ppt', 'available');
    assert.equal(h.STATE.pendingItems.length, 1);
});

test('an application error is not mistaken for a lock denial and applied twice', async () => {
    const h = harness();
    h.window.navigator.locks = null;
    let calls = 0;
    await assert.rejects(h.mutateState(() => { calls++; throw new Error('Invalid capture'); }), /Invalid capture/);
    assert.equal(calls, 1);
});

test('cross-tab captures are serialized, deduplicated, and preserve local selection', async () => {
    const shared = { storage: memoryStorage(), locks: locks() };
    const a = harness(shared), b = harness(shared);
    await Promise.all([
        a.addPendingItem('A', payload, {}, 'ppt', 'a'),
        b.addPendingItem('B', payload, {}, 'ppt', 'b'),
        b.addPendingItem('A duplicate', payload, {}, 'ppt', 'a'),
    ]);
    a.loadState(); b.loadState();
    assert.equal(a.STATE.pendingItems.length, 2);
    assert.equal(new Set(a.STATE.pendingItems.map(it => it.id)).size, 2);
    a.selectAll(false);
    await b.addPendingItem('C', payload, {}, 'ppt', 'c');
    a.reloadStateAndUI();
    assert.deepEqual(Array.from(a.STATE.pendingItems, it => it.checked), [false, false, true]);
    b.loadState();
    assert.ok(b.STATE.pendingItems.every(it => it.checked));
    await a.onClearAll();
    b.loadState();
    assert.equal(b.STATE.pendingItems.length, 0);
    assert.equal(b.STATE.processedKeys.size, 3);
});

test('legacy numeric IDs/unchecked items load; sources exist before publishing metadata', async () => {
    const storage = memoryStorage();
    storage.setItem(stateKey, JSON.stringify({ pendingMeta: [{ id: 1, name: 'Old', checked: false }] }));
    storage.setItem('rc_source_1', JSON.stringify(payload));
    const h = harness({ storage });
    h.loadState();
    assert.equal(h.STATE.pendingItems[0].id, '1');
    assert.equal(h.STATE.pendingItems[0].checked, false);
    const original = storage.setItem;
    storage.setItem = (key, value) => {
        if (key === stateKey) {
            for (const item of JSON.parse(value).pendingMeta) assert.ok(storage.getItem('rc_source_' + item.id));
        }
        original(key, value);
    };
    await h.addPendingItem('New', payload, {}, 'ppt', 'new');
});

test('frame captures only dispatch string events on the top document; unrelated endpoints are ignored', () => {
    const messages = [];
    const topDoc = testDocument();
    topDoc.addEventListener('rc-downloader-capture-v1', event => messages.push(event.detail));
    const h = harness({ top: { document: topDoc } });
    h.processApiResponse(h.CONFIG.FETCH_URL, payload);
    h.processApiResponse('https://evil.test/lesson/presentation/fetch', payload);
    assert.equal(messages.length, 1);
    assert.equal(typeof messages[0], 'string');
    assert.equal(JSON.parse(messages[0]).url, h.CONFIG.FETCH_URL);
    assert.equal(h.storage.getItem(stateKey), null);
    assert.equal(h.STATE.pendingItems.length, 0);
    assert.equal(h.isVideoUrl('https://evil.test/ks-playback.xuetangx.com/liveRecordLive/v.mp4'), false);
});

test('sandboxed frame relay stays within its own tab and rejects foreign API URLs', async () => {
    const page = {}; page.top = page;
    const h = harness({ pageWindow: page });
    const otherTab = harness();
    h.setupFrameListener(); otherTab.setupFrameListener();
    const framePage = { top: page };
    const child = harness({ pageWindow: framePage });
    child.setupFrameRelay();
    child.processApiResponse('https://evil.test/api/v3/lesson/presentation/fetch', payload);
    await tick();
    assert.equal(h.STATE.pendingItems.length, 0);
    child.processApiResponse(child.CONFIG.FETCH_URL, payload);
    await tick();
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(otherTab.STATE.pendingItems.length, 0);
    assert.equal(child.STATE.pendingItems.length, 0);
    assert.equal(child.storage.getItem(stateKey), null);
});

test('early frame captures retry across sandboxes until the top document acknowledges them', async () => {
    const messages = [];
    const page = {}; page.top = page;
    const top = harness({ pageWindow: page });
    top.window.document.addEventListener('rc-downloader-capture-v1', e => messages.push(JSON.parse(e.detail)));
    const child = harness({ pageWindow: { top: page } });
    child.setupFrameRelay();
    child.processApiResponse(child.CONFIG.FETCH_URL, payload);
    assert.equal(messages.length, 1);
    top.setupFrameListener();
    child.intervals[0]();
    await tick();
    assert.equal(messages.length, 2);
    assert.equal(top.STATE.pendingItems.length, 1);
    child.intervals[0]();
    assert.equal(messages.length, 2);
});

test('a cross-origin top document remains inaccessible and cannot receive captures', () => {
    const page = { top: { get document() { throw new Error('SecurityError'); } } };
    const h = harness({ pageWindow: page });
    h.setupFrameRelay();
    h.processApiResponse(h.CONFIG.FETCH_URL, payload);
    assert.equal(h.STATE.pendingItems.length, 0);
    assert.equal(h.storage.getItem(stateKey), null);
    assert.equal(h.IS_TOP_WINDOW, false);
});

test('login route matching covers QR/hash login without treating redirect parameters as login', () => {
    const h = harness();
    for (const url of ['/login', '/v2/web/qr-login', '/#/login?redirect=/course', 'https://open.weixin.qq.com/connect/qrconnect']) {
        assert.equal(h.isLoginUrl(url), true, url);
    }
    assert.equal(h.isLoginUrl('/v2/web/student-lesson-report/1/2/3?from=login'), false);
});

test('visible nested login frames hide the top panel; hidden login frames do not', () => {
    const h = harness();
    const doc = elements => ({ querySelectorAll: () => elements, defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) } });
    const qr = { tagName: 'IFRAME', src: 'https://open.weixin.qq.com/connect/qrconnect', getClientRects: () => [{}] };
    const course = { tagName: 'IFRAME', src: '/m/v2/lesson/student/1/overview', getClientRects: () => [{}], contentDocument: doc([qr]) };
    h.window.document = doc([course]);
    assert.equal(h.isLoginScreen(), true);
    qr.getClientRects = () => [];
    assert.equal(h.isLoginScreen(), false);
});

test('work pool refills idle workers while an earlier request is stalled', async () => {
    const h = harness();
    const starts = [];
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const result = h.runPool([0, 1, 2, 3, 4], 2, async i => {
        starts.push(i);
        if (i === 0) await blocked;
    });
    await tick();
    assert.deepEqual(starts, [0, 1, 2, 3, 4]);
    release(); await result;
});

test('image requests share a global connection limit and preserve page order', async () => {
    let active = 0, maximum = 0;
    const h = harness({ request: options => {
        active++; maximum = Math.max(maximum, active);
        setTimeout(() => {
            active--;
            options.onload({ status: 200, response: new Blob([options.url]) });
        }, options.url.endsWith('1') ? 15 : 2);
        return { abort() {} };
    } });
    h.CONFIG.MAX_WORKERS = 3;
    const items = Array.from({ length: 7 }, (_, i) => [i + 1, 'image-' + (i + 1)]);
    const task = () => ({ name: 'Course', downloaded: 0, total: 7 });
    const [a, b] = await Promise.all([h.downloadCovers(items, {}, task()), h.downloadCovers(items, {}, task())]);
    assert.equal(maximum, 3);
    assert.equal(active, 0);
    assert.deepEqual(await Promise.all(Array.from(a, blob => blob.text())), items.map(it => it[1]));
    assert.equal(b.length, 7);
});

function videoHarness(mode = 'ranges') {
    const bytes = Buffer.from(Array.from({ length: 43 }, (_, i) => i));
    let active = 0, maximum = 0, aborted = 0;
    const calls = [];
    const h = harness({ request: options => {
        calls.push(options.headers);
        active++; maximum = Math.max(maximum, active);
        const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range || '');
        const start = match ? Number(match[1]) : 0;
        const end = match ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
        const partial = !!match && mode !== 'ignore' && !(mode === 'later-ignore' && start > 0);
        let done = false;
        const timer = setTimeout(() => {
            if (mode === 'later-ignore' && start > 0) {
                options.onreadystatechange?.({ readyState: 2, status: 200 });
                if (done) return;
            }
            done = true; active--;
            let body = partial ? bytes.subarray(start, end + 1) : bytes;
            if (mode === 'truncated' && start === 8) body = body.subarray(1);
            options.onprogress?.({ loaded: body.length, total: body.length, lengthComputable: true });
            options.onload({ status: partial ? 206 : 200, response: new Blob([body]),
                responseHeaders: `Content-Type: video/mp4\r\nETag: "v1"\r\nContent-Length: ${body.length}\r\n` +
                    (partial ? `Content-Range: bytes ${start}-${end}/${bytes.length}\r\n` : '') });
        }, start === 8 ? 15 : 3);
        return { abort() { if (!done) { done = true; clearTimeout(timer); active--; aborted++; options.onabort?.(); } } };
    } });
    Object.assign(h.CONFIG, { VIDEO_CHUNK_BYTES: 8, VIDEO_WORKERS: 3, MAX_WORKERS: 3 });
    return { h, bytes, calls, metrics: () => ({ active, maximum, aborted }) };
}

test('video downloads concurrent byte ranges and assembles exact bytes in order', async () => {
    const { h, bytes, calls, metrics } = videoHarness();
    const task = { name: 'Video', downloaded: 0, total: 0 };
    const blob = await h.downloadVideo('https://example.test/video.mp4', {}, task);
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
    assert.equal(calls.length, 6);
    assert.equal(metrics().maximum, 3);
    assert.equal(metrics().active, 0);
    assert.equal(task.downloaded, bytes.length);
    assert.equal(task.total, bytes.length);
    assert.ok(calls.slice(1).every(headers => headers['If-Range'] === '"v1"'));
});

test('a server ignoring the first Range response is downloaded only once', async () => {
    const { h, bytes, calls } = videoHarness('ignore');
    const blob = await h.downloadVideo('https://example.test/video.mp4', {}, { name: 'Video' });
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
    assert.equal(calls.length, 1);
});

for (const mode of ['truncated', 'later-ignore']) {
    test(`${mode} segment cancels parallel work and falls back without corrupting the file`, async () => {
        const { h, bytes, calls, metrics } = videoHarness(mode);
        const blob = await h.downloadVideo('https://example.test/video.mp4', {}, { name: 'Video' });
        assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
        assert.equal(calls.filter(headers => !headers.Range).length, 1);
        assert.equal(metrics().active, 0);
        if (mode === 'later-ignore') assert.ok(metrics().aborted > 0);
    });
}

test('parallel job queue removes selected rows immediately, rejects double clicks, restores failures', async () => {
    const h = harness();
    for (let i = 0; i < 4; i++) await h.addPendingItem('job-' + i, payload, {}, 'ppt', String(i));
    let active = 0, maximum = 0, executed = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    h.setExecutor(async item => {
        active++; executed++; maximum = Math.max(maximum, active);
        await gate;
        active--;
        if (item.name === 'job-1') throw new Error('Simulated network failure');
    });
    const result = h.onDownloadSelected();
    await h.onDownloadSelected();
    await tick();
    assert.equal(h.STATE.pendingItems.length, 0);
    assert.equal(maximum, 3);
    assert.equal(h.STATE.isProcessing, true);
    release(); await result;
    assert.equal(executed, 4);
    assert.equal(h.STATE.isProcessing, false);
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(h.STATE.pendingItems[0].name, 'job-1');
    assert.equal(h.STATE.pendingItems[0].checked, false);
});

test('failed images reject the whole courseware instead of silently dropping pages', async () => {
    let requests = 0;
    const h = harness({ request: options => {
        requests++;
        setImmediate(() => options.onload({ status: 404, response: new Blob([]) }));
        return { abort() {} };
    } });
    await assert.rejects(h.downloadCovers([[1, 'missing']], {}, { name: 'Course', downloaded: 0 }), /1 页下载失败/);
    assert.equal(requests, 1); // Permanent HTTP failures are not retried.
});

test('temporary image failure retries and releases its connection slot', async () => {
    let attempts = 0;
    const h = harness({ request: options => {
        attempts++;
        setImmediate(() => {
            if (attempts === 1) options.onerror({});
            else options.onload({ status: 200, response: new Blob(['image']) });
        });
        return { abort() {} };
    } });
    h.CONFIG.MAX_WORKERS = 1;
    const images = await h.downloadCovers([[1, 'retry']], {}, { name: 'Course', downloaded: 0 });
    assert.equal(attempts, 2);
    assert.equal(await images[0].text(), 'image');
});

test('truncated full video response cannot be reported as a successful download', async () => {
    const h = harness({ request: options => {
        setImmediate(() => options.onload({ status: 200, response: new Blob(['short']), responseHeaders: 'Content-Length: 100' }));
        return { abort() {} };
    } });
    await assert.rejects(h.downloadVideo('https://example.test/video', {}, { name: 'Video' }), /视频响应不完整/);
});

test('unavailable storage keeps captures usable in memory instead of erasing them on the next change', async () => {
    const storage = memoryStorage();
    storage.setItem = () => { throw new Error('Quota exceeded'); };
    const h = harness({ storage });
    await h.addPendingItem('First', payload, {}, 'ppt', 'one');
    h.selectAll(false);
    await h.addPendingItem('Second', payload, {}, 'ppt', 'two');
    assert.equal(h.STATE.pendingItems.length, 2);
    assert.equal(h.STATE.pendingItems[0].checked, false);
});

test('three real jobs download concurrently and save every PDF/video, counting only confirmed exports', async () => {
    const requests = new Map(), saves = [];
    const h = harness({
        request: options => { requests.set(options.url, options); return { abort() {} }; },
        download: options => { saves.push(options); return { abort() {} }; },
    });
    const slides = url => ({ data: { slides: [{ index: 1, cover: url }] } });
    await h.addPendingItem('[Courseware] 相同名称', slides('https://example.test/a.jpg'), {}, 'ppt', 'a');
    await h.addPendingItem('[Courseware] 相同名称', slides('https://example.test/b.jpg'), {}, 'ppt', 'b');
    await h.addPendingItem('[Recording] 测试', 'https://example.test/video.mp4', {}, 'video', 'v');
    const jobs = h.onDownloadSelected();
    await tick();
    assert.equal(requests.size, 3, 'all network jobs start without waiting for a save');
    const respond = (url, text) => requests.get(url).onload({ status: 200, response: new Blob([text]), responseHeaders: `Content-Length: ${text.length}` });
    // Finish the second job first; keep its save pending while the others finish.
    respond('https://example.test/b.jpg', 'slide-B');
    await tick(); await tick();
    respond('https://example.test/video.mp4', 'video-bytes');
    respond('https://example.test/a.jpg', 'slide-A');
    await jobs;
    assert.equal(saves.length, 1, 'only exports are serialized');
    assert.equal(h.STATE.readyFiles.size, 3);
    assert.equal(h.STATE.totalCompleted, 0);
    assert.equal(h.STATE.pendingItems.length, 0);
    assert.equal(h.STATE.isProcessing, false, 'save waits do not occupy network job slots');
    for (const expected of ['PDF:slide-B', 'video-bytes', 'PDF:slide-A']) {
        const current = saves.at(-1);
        assert.equal(await (await fetch(current.url)).text(), expected);
        assert.equal(current.conflictAction, 'uniquify', 'same names must not overwrite');
        assert.equal(current.saveAs, false);
        current.onload();
        current.onload(); // Duplicate callbacks must not double-count or affect next export.
        current.onerror({ error: 'not_succeeded' });
        await tick();
        await assert.rejects(fetch(current.url), 'URL is released only after the terminal callback');
    }
    await h.whenSavesSettle();
    assert.equal(saves.length, 3);
    assert.equal(saves[0].name, '[课件] 相同名称.pdf');
    assert.equal(saves[2].name, saves[0].name);
    assert.equal(h.STATE.readyFiles.size, 0);
    assert.equal(h.STATE.totalCompleted, 3);
    assert.equal(requests.size, 3);
});

test('second export failure retains exact bytes, does not block third, and retries without network', async () => {
    const saves = [];
    const h = harness({ download: options => { saves.push(options); return { abort() {} }; } });
    const files = [1, 2, 3].map(n => h.retainFile({ id: String(n) }, new Blob(['file-' + n]), n + '.pdf'));
    await tick();
    saves[0].onload(); await tick();
    saves[1].onerror({ error: 'not_permitted' }); await tick();
    assert.equal(saves.length, 3);
    saves[2].onload(); await h.whenSavesSettle();
    assert.equal(h.STATE.totalCompleted, 2);
    assert.equal(h.STATE.readyFiles.size, 1);
    assert.equal(files[1].status, 'failed');
    assert.match(files[1].error, /下载权限/);
    assert.equal(await files[1].blob.text(), 'file-2');
    assert.equal(h.STATE.pendingItems.length, 0, 'export failure must not trigger a full redownload');
    await h.onClearAll();
    assert.equal(h.STATE.readyFiles.size, 1, 'clear pending list must preserve finished files');
    h.queueFileSave(files[1]);
    h.queueFileSave(files[1]);
    await tick();
    assert.equal(saves.length, 4, 'double click cannot enqueue duplicate exports');
    assert.equal(await (await fetch(saves[3].url)).text(), 'file-2');
    saves[3].onload(); await h.whenSavesSettle();
    assert.equal(h.STATE.totalCompleted, 3);
    assert.equal(h.STATE.readyFiles.size, 0);
    assert.ok(files.every(file => file.blob === null));
});

for (const mode of ['native', 'disabled', 'missing-grant']) {
    test(`${mode} export cannot report success or silently fall back to a.click`, async () => {
        let calls = 0;
        const h = harness({ downloadMode: mode, download: mode === 'missing-grant' ? undefined : () => { calls++; } });
        const file = h.retainFile({ id: 'a' }, new Blob(['data']), 'a.mp4');
        await h.whenSavesSettle();
        assert.equal(calls, 0);
        assert.equal(h.STATE.totalCompleted, 0);
        assert.equal(h.STATE.readyFiles.get('a'), file);
        assert.equal(file.status, 'failed');
        assert.match(file.error, /Tampermonkey|GM_download/);
    });
}

test('save timeout aborts, retains file, ignores late success, and allows later exports', async () => {
    let aborted = 0;
    const saves = [];
    const h = harness({ download: options => {
        saves.push(options);
        if (saves.length > 1) setImmediate(options.onload);
        return { abort() { aborted++; options.onerror({ error: 'not_succeeded' }); } };
    } });
    h.CONFIG.SAVE_TIMEOUT_MS = 15;
    const first = h.retainFile({ id: '1' }, new Blob(['first']), '1.pdf');
    h.retainFile({ id: '2' }, new Blob(['second']), '2.pdf');
    await h.whenSavesSettle();
    saves[0].onload(); await tick();
    assert.equal(aborted, 1);
    assert.match(first.error, /超时.*未确认/);
    assert.equal(h.STATE.totalCompleted, 1);
    assert.equal(h.STATE.readyFiles.size, 1);
    assert.equal(await first.blob.text(), 'first');
});

test('synchronous manager exception and extension whitelist error retain files for recovery', async () => {
    let calls = 0;
    const h = harness({ download: options => {
        if (++calls === 1) throw new Error('扩展调用失败');
        options.onerror({ error: 'not_whitelisted' });
        return { abort() {} };
    } });
    const first = h.retainFile({ id: '1' }, new Blob(['one']), 'one.pdf');
    const second = h.retainFile({ id: '2' }, new Blob(['two']), 'two.mp4');
    await h.whenSavesSettle();
    assert.equal(h.STATE.totalCompleted, 0);
    assert.equal(first.status, 'failed');
    assert.match(second.error, /白名单.*pdf.*mp4/);
    assert.equal(h.STATE.readyFiles.size, 2);
});

test('Save As invokes picker in the click turn and confirms only after write AND close succeed', async () => {
    let picked = 0, written, releaseClose;
    const closing = new Promise(resolve => { releaseClose = resolve; });
    const h = harness({ picker: options => {
        picked++;
        assert.equal(options.suggestedName, '手动.pdf');
        return Promise.resolve({ createWritable: async () => ({
            write: async blob => { written = await blob.text(); }, close: () => closing,
        }) });
    } });
    const file = h.retainFile({ id: 'a' }, new Blob(['pdf bytes']), '手动.pdf');
    await h.whenSavesSettle();
    const saving = h.saveFileAs(file);
    assert.equal(picked, 1, 'picker invoked before any await that would lose user activation');
    await h.saveFileAs(file); // Double-click is ignored.
    await tick();
    assert.equal(written, 'pdf bytes');
    assert.equal(h.STATE.totalCompleted, 0);
    assert.equal(h.STATE.readyFiles.size, 1);
    releaseClose(); await saving;
    assert.equal(h.STATE.totalCompleted, 1);
    assert.equal(h.STATE.readyFiles.size, 0);
});

for (const failure of ['picker', 'write', 'close']) {
    test(`Save As ${failure} cancellation/failure keeps bytes and never counts success`, async () => {
        let aborted = 0;
        const h = harness({ picker: async () => {
            if (failure === 'picker') throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
            return { createWritable: async () => ({
                async write() { if (failure === 'write') throw new Error('磁盘已满'); },
                async close() { if (failure === 'close') throw new Error('无法提交文件'); },
                async abort() { aborted++; },
            }) };
        } });
        const file = h.retainFile({ id: 'a' }, new Blob(['keep me']), '手动.mp4');
        await h.whenSavesSettle();
        await h.saveFileAs(file);
        assert.equal(h.STATE.totalCompleted, 0);
        assert.equal(file.status, 'failed');
        assert.equal(await file.blob.text(), 'keep me');
        assert.equal(aborted, failure === 'picker' ? 0 : 1);
    });
}

test('beforeunload warns for network work and unsaved blobs, including after clearing records', async () => {
    const h = harness();
    let prevented = 0;
    const event = { preventDefault() { prevented++; } };
    h.warnBeforeLeaving(event);
    assert.equal(prevented, 0);
    h.STATE.isProcessing = true;
    h.warnBeforeLeaving(event);
    h.STATE.isProcessing = false;
    const file = h.retainFile({ id: 'a' }, new Blob(['data']), 'a.pdf');
    await h.whenSavesSettle();
    await h.onClearAll(true);
    h.warnBeforeLeaving(event);
    assert.equal(prevented, 2);
    assert.equal(h.STATE.readyFiles.get('a'), file);
});

test('legacy fire-and-forget completion count is not displayed as confirmed saves', async () => {
    const storage = memoryStorage();
    storage.setItem('rc_downloader_state', JSON.stringify({ totalCompleted: 99, processedKeys: ['existing'] }));
    const h = harness({ storage, download: options => { setImmediate(options.onload); return { abort() {} }; } });
    h.loadState();
    assert.equal(h.STATE.totalCompleted, 0);
    assert.equal(h.STATE.processedKeys.has('existing'), true);
    h.retainFile({ id: 'a' }, new Blob(['data']), 'a.pdf');
    await h.whenSavesSettle();
    const other = harness({ storage });
    other.loadState();
    assert.equal(other.STATE.totalCompleted, 1);
});

const pptUrl = (id, stamp = 1) => `https://pro.yuketang.cn/api/v3/classroom-report/student/ppt?lesson_id=7&presentationId=${id}&front_time=${stamp}`;
const pptPayload = id => ({ data: { timelineList: [{ index: 1, cover: `https://example.test/${id}.jpg` }] } });

test('direct PPT endpoints from the saved Rain Classroom site are allowlisted without matching foreign hosts', () => {
    const h = harness();
    for (const url of [pptUrl('a'), '/api/v3/classroom-report/ppt/', '/api/v4/classroom-report/student/ppt']) {
        assert.equal(h.apiEndpoint(url), h.CONFIG.PPT_URL);
    }
    for (const url of ['https://evil.test/api/v3/classroom-report/student/ppt', '/api/v3/classroom-report/ppt/delete']) {
        assert.equal(h.apiEndpoint(url), undefined);
    }
});

test('page fetch can capture a direct PPT response without any preceding lesson-info', async () => {
    const page = { fetch: async () => new Response(JSON.stringify(pptPayload('a'))) }; page.top = page;
    const h = harness({ pageWindow: page });
    h.setupFetchInterceptor();
    await page.fetch(pptUrl('a'));
    await tick(); await tick();
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(h.STATE.pendingItems[0].captureKey, 'lesson:7:a');
    assert.equal(h.STATE.pendingItems[0].type, 'ppt');
});

test('iframe direct PPT relay preserves lesson and presentation query IDs and deduplicates with lesson-info', async () => {
    const topPage = {}; topPage.top = topPage;
    const top = harness({ pageWindow: topPage });
    top.setupFrameListener();
    const frame = harness({ pageWindow: { top: topPage } });
    frame.setupFrameRelay();
    frame.processApiResponse(pptUrl('a'), pptPayload('a'));
    await tick();
    assert.equal(top.STATE.pendingItems[0].captureKey, 'lesson:7:a');
    await top.handleLessonInfo({ data: { lessonId: '7', presentationIds: ['a'], lessonName: '测试课', teacherName: '教师' } });
    assert.equal(top.STATE.pendingItems.length, 1);
    assert.equal(top.STATE.presentationIdToContext.a.lessonName, '测试课');
    assert.equal(frame.STATE.pendingItems.length, 0);
});

test('original lesson-info to PPT fetch path still captures every presentation and direct response adds no duplicate', async () => {
    const calls = [];
    const h = harness({ request: options => {
        calls.push(options.url);
        const id = new URL(options.url).searchParams.get('presentationId');
        setImmediate(() => options.onload({ status: 200, responseText: JSON.stringify(pptPayload(id)) }));
    } });
    await h.processApiResponse(h.CONFIG.LESSON_INFO_URL, { data: {
        lessonId: '7', presentationIds: ['a', 'b'], lessonName: '高等数学', teacherName: '教师',
    } });
    assert.equal(calls.length, 2);
    assert.equal(h.STATE.pendingItems.length, 2);
    assert.deepEqual(Array.from(h.STATE.pendingItems, item => item.name), ['[课件] 高等数学_教师_1', '[课件] 高等数学_教师_2']);
    await h.processApiResponse(pptUrl('a'), pptPayload('a'));
    assert.equal(h.STATE.pendingItems.length, 2);
});

test('an authenticated page PPT response still captures when the manager follow-up request fails', async () => {
    const h = harness({ request: options => setImmediate(() => options.onload({ status: 403, responseText: '{}' })) });
    await h.processApiResponse(h.CONFIG.LESSON_INFO_URL, { data: { lessonId: '7', presentationIds: ['a'] } });
    assert.equal(h.STATE.pendingItems.length, 0);
    assert.match(h.getCoursewareStatus(), /获取课件失败.*403/);
    await h.processApiResponse(pptUrl('a'), pptPayload('a'));
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.match(h.getCoursewareStatus(), /已加入课件/);
});

test('late recovery keeps all presentations from the same PPT endpoint, ignoring only timestamp duplicates', async () => {
    const page = { performance: { getEntriesByType: () => [
        { name: pptUrl('a', 1) }, { name: pptUrl('b', 1) }, { name: pptUrl('a', 2) },
    ] } }; page.top = page;
    const calls = [];
    const h = harness({ pageWindow: page, request: options => {
        calls.push(options.url);
        const id = new URL(options.url).searchParams.get('presentationId');
        setImmediate(() => options.onload({ status: 200, responseText: JSON.stringify(pptPayload(id)) }));
    } });
    await h.rescanCurrentDocument();
    assert.equal(h.STATE.pendingItems.length, 2);
    assert.deepEqual(calls, [pptUrl('b', 1), pptUrl('a', 2)]);
    await h.rescanCurrentDocument();
    assert.equal(calls.length, 2);
});

test('resource observer recovers courseware if the site bypasses the wrapped fetch', { timeout: 3000 }, async () => {
    let notify, requestCount = 0, finish;
    const requested = new Promise(resolve => { finish = resolve; });
    const h = harness({ performanceObserver: class {
        constructor(callback) { notify = callback; } observe() {}
    }, request: options => {
        requestCount++;
        setImmediate(() => { options.onload({ status: 200, responseText: JSON.stringify(pptPayload('a')) }); finish(); });
    } });
    h.setupResourceRecovery();
    notify({ getEntries: () => [{ name: pptUrl('a') }, { name: pptUrl('a', 2) }] });
    await requested; await tick();
    assert.equal(requestCount, 1);
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(h.STATE.pendingItems[0].captureKey, 'lesson:7:a');
});

test('resource observer avoids re-requesting responses already captured by fetch/XHR', async () => {
    let notify;
    const h = harness({ performanceObserver: class {
        constructor(callback) { notify = callback; } observe() {}
    } });
    h.setupResourceRecovery();
    notify({ getEntries: () => [{ name: pptUrl('a') }] });
    await h.processApiResponse(pptUrl('a'), pptPayload('a'));
    await new Promise(resolve => setTimeout(resolve, 230));
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.match(h.getCoursewareStatus(), /已加入课件/);
});

test('recapture restores a courseware suppressed by old records without clearing videos, selection or save count', async () => {
    const h = harness();
    await h.mutateState(() => { h.STATE.processedKeys.add('lesson:7:a'); h.STATE.totalCompleted = 3; });
    await h.addPendingItem('保留视频', 'https://example.test/video.mp4', {}, 'video', 'video:keep');
    h.selectAll(false);
    await h.processApiResponse(pptUrl('a'), pptPayload('a'));
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.match(h.getCoursewareStatus(), /采集记录跳过/);
    // No performance entries or network stub: recover from the observed response.
    await h.rescanCurrentDocument({ force: true, recover: true, coursewareOnly: true });
    assert.equal(h.STATE.pendingItems.length, 2);
    assert.equal(h.STATE.pendingItems[0].checked, false);
    assert.equal(h.STATE.pendingItems[1].captureKey, 'lesson:7:a');
    assert.equal(h.STATE.totalCompleted, 3);
    await h.rescanCurrentDocument({ force: true, recover: true, coursewareOnly: true });
    assert.equal(h.STATE.pendingItems.length, 2);
});

test('recovery of an existing legacy row neither duplicates it nor changes its selection', async () => {
    const storage = memoryStorage();
    storage.setItem(stateKey, JSON.stringify({ pendingMeta: [{ id: 1, name: '旧课件', checked: false }], processedKeys: ['lesson:7:a'] }));
    storage.setItem('rc_source_1', JSON.stringify(pptPayload('a')));
    const h = harness({ storage }); h.loadState();
    await h.processApiResponse(pptUrl('a'), pptPayload('a'), { recover: true });
    assert.equal(h.STATE.pendingItems.length, 1);
    assert.equal(h.STATE.pendingItems[0].checked, false);
});

test('recapture does not duplicate a job waiting for a network worker or a retained export', async () => {
    const h = harness();
    for (const id of ['a', 'b', 'c', 'd']) await h.processApiResponse(pptUrl(id), pptPayload(id));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    h.setExecutor(async () => gate);
    const jobs = h.onDownloadSelected();
    await tick();
    assert.equal(h.STATE.runningItems.size, 4);
    await h.processApiResponse(pptUrl('d'), pptPayload('d'), { recover: true });
    assert.equal(h.STATE.pendingItems.length, 0);
    release(); await jobs;
    assert.equal(h.STATE.runningItems.size, 0);
    const file = h.retainFile({ id: 'saved-a', type: 'ppt', captureKey: 'lesson:7:a', source: pptPayload('a') }, new Blob(['PDF bytes']), 'a.pdf');
    await h.whenSavesSettle();
    await h.processApiResponse(pptUrl('a'), pptPayload('a'), { recover: true });
    assert.equal(h.STATE.pendingItems.length, 0);
    assert.equal(h.STATE.readyFiles.get('saved-a'), file);
});

test('unparseable courseware is visible in early diagnostics and does not poison capture records', async () => {
    const h = harness();
    await h.processApiResponse(pptUrl('a'), { data: {} });
    assert.match(h.getCoursewareStatus(), /未返回可用课件页/);
    assert.ok(h.getEarlyLogs().some(entry => entry.msg.includes('直接课件接口')));
    assert.equal(h.STATE.processedKeys.has('lesson:7:a'), false);
    await h.processApiResponse(pptUrl('a'), pptPayload('a'));
    assert.equal(h.STATE.pendingItems.length, 1);
});
