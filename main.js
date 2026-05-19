// ==UserScript==
// @name         雨课堂课件插件
// @namespace    https://github.com/c0d805e15c550432/Rainclassroom_Plugin
// @version      1.0.0
// @description  下载雨课堂课堂回顾的课件及视频
// @author       zhzh
// @match        https://pro.yuketang.cn/*
// @icon         https://pro.yuketang.cn/favicon.ico
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @require      https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js
// @require      https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
// @connect      *
// @run-at       document-start
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 配置常量 ====================
    const CONFIG = {
        INDEX_URL: 'https://pro.yuketang.cn/v2/web/index',
        LESSON_INFO_URL: 'https://pro.yuketang.cn/api/v3/classroom-report/student/lesson-info',
        FETCH_URL: 'https://pro.yuketang.cn/api/v3/lesson/presentation/fetch',
        PPT_URL: 'https://pro.yuketang.cn/api/v3/classroom-report/student/ppt',
        CHECK_PERMISSION_URL: 'https://pro.yuketang.cn/api/v3/lesson/meeting/meds/check-permission',

        // 视频回放域名和路径（两种回放源）
        VIDEO_SOURCES: [
            { host: 'ks-playback.xuetangx.com', pathPrefix: '/liveRecordLive/' },
            { host: 'tx-playback.xuetangx.com', pathPrefix: '/origin/' },
        ],

        MAX_WORKERS: 12,
        MAX_RETRIES: 3,
        RETRY_BACKOFF_MS: 800,
        VIDEO_TIMEOUT_MS: 600000,  // 视频下载超时 10 分钟
    };

    // ==================== 状态管理 ====================
    const STATE = {
        processedKeys: new Set(),
        pendingItems: [],         // { id, name, type:'ppt'|'video', source, headers, checked }
        downloadQueue: [],
        isProcessing: false,
        totalCompleted: 0,
        currentTask: null,
        itemIdCounter: 0,
        presentationIdToContext: {},  // presentationId → { lessonName, teacherName, index, suffix }
        activeLesson: null,            // { lessonName, teacherName } — 最近一次课件上下文，供视频命名
    };

    // ==================== 跨窗口状态持久化 (localStorage + storage 事件) ====================
    // 使用 localStorage 而非 sessionStorage，因为雨课堂会在新窗口中打开课件，
    // sessionStorage 在不同窗口间是隔离的，localStorage 在同源窗口间共享。
    // 配合 storage 事件，任意窗口的状态变更都能同步到其他窗口。
    const STORAGE_KEY = 'rc_downloader_state';
    const STORAGE_SOURCE_PREFIX = 'rc_source_';
    const STORAGE_HEADERS_PREFIX = 'rc_headers_';
    let _storageDebounceTimer = null;

    function saveState() {
        try {
            const meta = {
                processedKeys: [...STATE.processedKeys],
                pendingMeta: STATE.pendingItems.map(it => ({ id: it.id, name: it.name, type: it.type || 'ppt', checked: it.checked })),
                totalCompleted: STATE.totalCompleted,
                itemIdCounter: STATE.itemIdCounter,
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));

            // 分别存储 source 和 headers（可能很大）
            STATE.pendingItems.forEach(it => {
                try {
                    const srcVal = typeof it.source === 'string' ? JSON.stringify(it.source) : JSON.stringify(it.source);
                    localStorage.setItem(STORAGE_SOURCE_PREFIX + it.id, srcVal);
                } catch (e) {}
                try { localStorage.setItem(STORAGE_HEADERS_PREFIX + it.id, JSON.stringify(it.headers)); } catch (e) {}
            });
        } catch (e) {
            // localStorage 满或不可用，静默忽略
        }
    }

    function loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            const meta = JSON.parse(raw);

            STATE.processedKeys = new Set(meta.processedKeys || []);
            STATE.totalCompleted = meta.totalCompleted || 0;
            STATE.itemIdCounter = meta.itemIdCounter || 0;

            STATE.pendingItems = (meta.pendingMeta || []).map(m => {
                let source = null;
                let headers = null;
                // 视频类型的 source 就是 URL 字符串，不需要从 storage 恢复
                const itemType = m.type || 'ppt';
                if (itemType === 'video') {
                    // 视频：source 即为 URL，优先从单独存储恢复
                    try {
                        const srcRaw = localStorage.getItem(STORAGE_SOURCE_PREFIX + m.id);
                        if (srcRaw) source = JSON.parse(srcRaw);
                    } catch (e) {}
                } else {
                    try {
                        const srcRaw = localStorage.getItem(STORAGE_SOURCE_PREFIX + m.id);
                        if (srcRaw) source = JSON.parse(srcRaw);
                    } catch (e) {}
                }
                try {
                    const hdrRaw = localStorage.getItem(STORAGE_HEADERS_PREFIX + m.id);
                    if (hdrRaw) headers = JSON.parse(hdrRaw);
                } catch (e) {}
                return { id: m.id, name: m.name, type: itemType, source, headers, checked: m.checked };
            }).filter(it => it.source !== null);

            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * 从 localStorage 重新加载状态并刷新 UI。
     * 当其他窗口通过 storage 事件通知变更时调用。
     */
    function reloadStateAndUI() {
        if (!loadState()) return;

        // 重建待确认列表 UI
        const list = document.getElementById('rc-pending-list');
        if (!list) {
            // 面板尚未创建（storage 事件在 DOM ready 之前触发），稍后 init 会处理
            return;
        }
        list.innerHTML = '';
        STATE.pendingItems.forEach(item => renderPendingItem(item));
        updatePendingStats();
        updateDownloadBtn();
        uiLog('🔄 其他窗口更新了课件列表，已同步');
    }

    function clearStorage() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const meta = JSON.parse(raw);
                (meta.pendingMeta || []).forEach(m => {
                    localStorage.removeItem(STORAGE_SOURCE_PREFIX + m.id);
                    localStorage.removeItem(STORAGE_HEADERS_PREFIX + m.id);
                });
            }
            localStorage.removeItem(STORAGE_KEY);
        } catch (e) {}
    }

    /**
     * 监听其他窗口的 localStorage 变更（storage 事件仅在"其他"窗口触发）。
     * 防抖处理避免短时间内多次刷新 UI。
     */
    function setupStorageListener() {
        window.addEventListener('storage', function (e) {
            // 只关心我们自己的 key
            if (e.key === STORAGE_KEY || (e.key && e.key.startsWith(STORAGE_SOURCE_PREFIX)) || (e.key && e.key.startsWith(STORAGE_HEADERS_PREFIX))) {
                if (e.key === STORAGE_KEY && e.newValue === null) {
                    // 被其他窗口清空了，同步清空
                    STATE.pendingItems = [];
                    STATE.processedKeys = new Set();
                    STATE.totalCompleted = 0;
                    const list = document.getElementById('rc-pending-list');
                    if (list) list.innerHTML = '';
                    updatePendingStats();
                    updateDownloadBtn();
                    return;
                }
                // 防抖：200ms 内的多次变更合并为一次刷新
                clearTimeout(_storageDebounceTimer);
                _storageDebounceTimer = setTimeout(reloadStateAndUI, 200);
            }
        });
    }

    // ==================== 工具函数 ====================
    function sanitizeFilename(name) {
        if (typeof name !== 'string') name = String(name || 'untitled');
        name = name.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim();
        return name.slice(0, 180) || 'untitled';
    }

    function getCookieHeader() {
        return document.cookie;
    }

    function buildApiHeaders() {
        return {
            'accept': 'application/json, text/plain, */*',
            'referer': CONFIG.INDEX_URL,
            'cookie': getCookieHeader(),
            'user-agent': navigator.userAgent,
            'sec-ch-ua-platform': '"Windows"',
            'sec-ch-ua': '"Chromium";v="145", "Not:A-Brand";v="99"',
            'dnt': '1',
            'sec-ch-ua-mobile': '?0',
            'sec-fetch-site': 'same-site',
            'sec-fetch-mode': 'cors',
            'sec-fetch-dest': 'empty',
            'accept-language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
        };
    }

    function gmRequestJSON(url, headers, params) {
        return new Promise((resolve, reject) => {
            let fullUrl = url;
            if (params) {
                const searchParams = new URLSearchParams(params);
                fullUrl = url + (url.includes('?') ? '&' : '?') + searchParams.toString();
            }
            GM_xmlhttpRequest({
                method: 'GET',
                url: fullUrl,
                headers: headers,
                timeout: 30000,
                onload: function (resp) {
                    try {
                        resolve(JSON.parse(resp.responseText));
                    } catch (e) {
                        reject(new Error('JSON 解析失败: ' + e.message));
                    }
                },
                onerror: function (err) {
                    reject(new Error('请求失败: ' + (err.statusText || 'network error')));
                },
                ontimeout: function () {
                    reject(new Error('请求超时'));
                },
            });
        });
    }

    function gmDownloadImage(url, headers, retries = CONFIG.MAX_RETRIES) {
        return new Promise((resolve, reject) => {
            function attempt(n) {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url: url,
                    headers: headers,
                    responseType: 'blob',
                    timeout: 30000,
                    onload: function (resp) {
                        if (resp.status >= 200 && resp.status < 300) {
                            resolve(resp.response);
                        } else if (n < retries) {
                            setTimeout(() => attempt(n + 1), CONFIG.RETRY_BACKOFF_MS * Math.pow(2, n));
                        } else {
                            reject(new Error('HTTP ' + resp.status));
                        }
                    },
                    onerror: function () {
                        if (n < retries) {
                            setTimeout(() => attempt(n + 1), CONFIG.RETRY_BACKOFF_MS * Math.pow(2, n));
                        } else {
                            reject(new Error('Network error'));
                        }
                    },
                    ontimeout: function () {
                        if (n < retries) {
                            setTimeout(() => attempt(n + 1), CONFIG.RETRY_BACKOFF_MS * Math.pow(2, n));
                        } else {
                            reject(new Error('Timeout'));
                        }
                    },
                });
            }
            attempt(1);
        });
    }

    function loadCoverItems(indexPayload) {
        if (typeof indexPayload !== 'object' || indexPayload === null) return [];

        let data = indexPayload.data;
        if (typeof data === 'string') {
            const text = data.trim();
            if (text && (text[0] === '[' || text[0] === '{')) {
                try { data = JSON.parse(text); } catch (e) { return []; }
            } else { return []; }
        }

        let timeline;
        if (Array.isArray(data)) {
            timeline = data;
        } else if (typeof data === 'object' && data !== null) {
            const listName = ['slideList', 'timelineList', 'slides'].find(n => n in data) || 'timelineList';
            timeline = data[listName] || [];
        } else { return []; }

        if (typeof timeline === 'string') {
            const text = timeline.trim();
            if (text && (text[0] === '[' || text[0] === '{')) {
                try { timeline = JSON.parse(text); } catch (e) { return []; }
            } else { return []; }
        }

        if (!Array.isArray(timeline)) return [];

        const items = [];
        timeline.forEach((entry, pos) => {
            let cover = null, pageIndex = null;
            if (typeof entry === 'object' && entry !== null) {
                cover = entry.cover;
                pageIndex = entry.index;
            } else if (typeof entry === 'string') {
                cover = entry;
                pageIndex = pos + 1;
            }
            if (typeof pageIndex === 'string' && /^\d+$/.test(pageIndex)) pageIndex = parseInt(pageIndex, 10);
            if (typeof cover === 'string' && cover.trim() && typeof pageIndex === 'number') items.push([pageIndex, cover]);
        });

        const seen = new Set();
        const deduped = [];
        items.sort((a, b) => a[0] - b[0]);
        for (const [idx, url] of items) {
            if (seen.has(idx)) continue;
            seen.add(idx);
            deduped.push([idx, url]);
        }
        return deduped;
    }

    // ==================== PDF 生成 ====================
    async function imagesToPdf(imageBlobs) {
        const { jsPDF } = window.jspdf;
        if (!imageBlobs || imageBlobs.length === 0) throw new Error('没有图片');

        const pdf = new jsPDF({ orientation: 'landscape', unit: 'px', format: [960, 540] });

        for (let i = 0; i < imageBlobs.length; i++) {
            if (i > 0) pdf.addPage([960, 540]);
            const dataUrl = await blobToDataUrl(imageBlobs[i]);
            const img = await loadImage(dataUrl);
            const ratio = Math.min(960 / img.width, 540 / img.height);
            const w = img.width * ratio, h = img.height * ratio;
            pdf.addImage(dataUrl, 'JPEG', (960 - w) / 2, (540 - h) / 2, w, h);
        }
        return pdf.output('blob');
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function loadImage(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = src;
        });
    }

    function triggerDownload(blob, filename) {
        // 使用 iframe 方式触发下载，避免弹窗
        const url = URL.createObjectURL(blob);
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        iframe.onload = function () {
            setTimeout(() => {
                document.body.removeChild(iframe);
                URL.revokeObjectURL(url);
            }, 2000);
        };
        // 同时尝试 <a> 标签方式作为备用
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        a.target = '_self';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
        }, 2000);
    }

    // ==================== 下载执行 ====================
    async function downloadCovers(items, headers, itemName) {
        const results = new Map();
        let failedCount = 0;
        let completedCount = 0;

        uiLog(`[${itemName}] 开始并发下载 ${items.length} 张图片 (并发数: ${CONFIG.MAX_WORKERS})`);

        async function downloadOne(index, url) {
            try {
                const blob = await gmDownloadImage(url, headers);
                results.set(index, blob);
                completedCount++;
                STATE.currentTask.downloaded = completedCount;
                refreshPendingUI();
            } catch (err) {
                failedCount++;
                uiLog(`[${itemName}] 第 ${index} 页下载失败: ${err.message}`, 'error');
            }
        }

        // 信号量调度：始终保持 MAX_WORKERS 个并发请求
        const lanes = new Array(Math.min(CONFIG.MAX_WORKERS, items.length)).fill(Promise.resolve());
        items.forEach(([index, url], i) => {
            const laneIdx = i % lanes.length;
            lanes[laneIdx] = lanes[laneIdx].then(() => downloadOne(index, url));
        });

        await Promise.all(lanes);

        if (failedCount > 0) uiLog(`[${itemName}] ${failedCount} 张下载失败`, 'warn');

        const sorted = [];
        for (const idx of [...results.keys()].sort((a, b) => a - b)) sorted.push(results.get(idx));
        return sorted;
    }

    /**
     * 下载视频文件。视频可能较大，使用长超时。
     */
    async function downloadVideo(videoUrl, headers) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: videoUrl,
                headers: Object.assign({
                    'Accept': '*/*',
                    'Accept-Encoding': 'identity',
                    'User-Agent': navigator.userAgent,
                }, headers),
                responseType: 'blob',
                timeout: CONFIG.VIDEO_TIMEOUT_MS,
                onload: function (resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.response);
                    } else {
                        reject(new Error('视频下载失败 HTTP ' + resp.status));
                    }
                },
                onerror: function (err) {
                    reject(new Error('视频下载网络错误: ' + (err.statusText || 'unknown')));
                },
                ontimeout: function () {
                    reject(new Error('视频下载超时（超过 ' + (CONFIG.VIDEO_TIMEOUT_MS / 60000) + ' 分钟）'));
                },
                onprogress: function (resp) {
                    // 更新下载进度
                    if (STATE.currentTask && resp.lengthComputable) {
                        STATE.currentTask.total = Math.ceil(resp.total / (1024 * 1024));
                        STATE.currentTask.downloaded = Math.ceil(resp.loaded / (1024 * 1024));
                        refreshPendingUI();
                    }
                },
            });
        });
    }

    async function executeOneJob(pendingItem) {
        const { name, type, source, headers } = pendingItem;

        // 视频下载：直接下载视频文件
        if (type === 'video') {
            STATE.currentTask = { name, total: 1, downloaded: 0 };
            refreshPendingUI();
            try {
                uiLog(`[${name}] 开始下载视频 ...`);
                const videoBlob = await downloadVideo(source, headers);
                triggerDownload(videoBlob, sanitizeFilename(name) + '.mp4');
                STATE.totalCompleted++;
                STATE.currentTask = null;
                refreshPendingUI();
                saveState();
                uiLog(`[${name}] ✅ 视频下载完成`, 'success');
            } catch (e) {
                STATE.currentTask = null;
                refreshPendingUI();
                throw e;
            }
            return;
        }

        // PPT 下载：原有逻辑
        STATE.currentTask = { name, total: 0, downloaded: 0 };
        refreshPendingUI();

        const items = loadCoverItems(source);
        if (!items || items.length === 0) throw new Error('未找到 cover 链接');

        STATE.currentTask.total = items.length;
        STATE.currentTask.downloaded = 0;
        refreshPendingUI();

        const imageBlobs = await downloadCovers(items, headers, name);
        if (imageBlobs.length === 0) throw new Error('图片下载全部失败');

        uiLog(`[${name}] 正在生成 PDF ...`);
        const pdfBlob = await imagesToPdf(imageBlobs);
        triggerDownload(pdfBlob, sanitizeFilename(name) + '.pdf');

        STATE.totalCompleted++;
        STATE.currentTask = null;
        refreshPendingUI();
        saveState();

        uiLog(`[${name}] ✅ 完成 (${imageBlobs.length} 页)`, 'success');
    }

    async function processDownloadQueue() {
        if (STATE.isProcessing) return;
        STATE.isProcessing = true;
        refreshPendingUI();

        while (STATE.downloadQueue.length > 0) {
            const item = STATE.downloadQueue.shift();
            removePendingFromUI(item.id);
            refreshPendingUI();
            try {
                uiLog(`▶ 开始: ${item.name}`);
                await executeOneJob(item);
            } catch (e) {
                uiLog(`✘ 失败: ${item.name} — ${e.message}`, 'error');
            }
        }

        STATE.isProcessing = false;
        refreshPendingUI();
    }

    // ==================== 添加到待确认列表 ====================
    function addPendingItem(name, source, headers, type = 'ppt') {
        const id = ++STATE.itemIdCounter;
        STATE.pendingItems.push({ id, name, type, source, headers, checked: true });
        renderPendingItem({ id, name, type, source, headers, checked: true });
        updatePendingStats();
        saveState();
        const typeLabel = type === 'video' ? '🎬 视频' : '� 课件';
        uiLog(`${typeLabel}: ${name}`);
    }

    // ==================== API 响应处理 ====================
    async function handleLessonInfo(payload) {
        const data = payload.data || {};
        const lessonId = data.lessonId;
        const presentationIds = data.presentationIds || [];
        const lessonName = String(data.lessonName || 'lesson');
        const teacherName = String(data.teacherName || 'teacher');

        if (!lessonId || !Array.isArray(presentationIds) || presentationIds.length === 0) return;

        // 记录当前课件上下文，供后续视频命名使用
        STATE.activeLesson = { lessonName, teacherName };

        const headers = buildApiHeaders();

        for (let i = 0; i < presentationIds.length; i++) {
            const presentationId = presentationIds[i];
            const key = `lesson:${lessonId}:${presentationId}`;
            if (STATE.processedKeys.has(key)) continue;
            STATE.processedKeys.add(key);

            const suffix = presentationIds.length > 1 ? `_${i + 1}` : '';
            const name = `[课件] ${lessonName}_${teacherName}${suffix}`;

            // 存储上下文映射：presentationId → 课件名称（供视频命名使用）
            STATE.presentationIdToContext[presentationId] = {
                lessonName, teacherName, index: i, suffix, fullName: name,
            };

            const params = {
                lesson_id: lessonId,
                presentationId: presentationId,
                front_time: String(Date.now()),
            };

            try {
                const pptPayload = await gmRequestJSON(CONFIG.PPT_URL, headers, params);
                addPendingItem(name, pptPayload, headers);
            } catch (e) {
                uiLog(`获取 PPT 失败: ${e.message}`, 'error');
            }
        }
    }

    function handleFetch(payload) {
        const data = payload.data || {};
        const activityId = data.activityId || data.activity_id || 'unknown';
        const slides = data.slides || [];
        const pages = slides.length;
        const title = '[课件] ' + String(data.title || 'fetch') + `_${pages}pages`;

        const key = `fetch:${activityId}:${title}:${pages}`;
        if (STATE.processedKeys.has(key)) return;
        STATE.processedKeys.add(key);

        const headers = buildApiHeaders();
        addPendingItem(title, payload, headers);
    }

    // ==================== 网络拦截 ====================
    function setupFetchInterceptor() {
        const originalFetch = window.fetch;
        window.fetch = async function (input, init) {
            const response = await originalFetch.apply(this, arguments);
            const clonedResponse = response.clone();
            const url = typeof input === 'string' ? input : (input.url || input.href || '');
            clonedResponse.text().then(text => {
                try { processApiResponse(url, JSON.parse(text)); } catch (e) { /* 非 JSON */ }
            }).catch(() => {});
            return response;
        };
    }

    function setupXHRInterceptor() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            this._rcUrl = url;
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            const xhr = this;
            const url = xhr._rcUrl || '';
            xhr.addEventListener('load', function () {
                if (xhr.responseType === '' || xhr.responseType === 'text') {
                    try { processApiResponse(url, JSON.parse(xhr.responseText)); } catch (e) {}
                }
            });
            return origSend.apply(this, arguments);
        };
    }

    function processApiResponse(url, json) {
        if (!json || typeof json !== 'object') return;

        if (url.includes('check-permission')) {
            if (json.code === 0 && json.msg === 'OK') {
                uiLog('✅ 登录状态有效', 'success');
            } else {
                uiLog('⚠️ 登录已失效，请重新登录！', 'warn');
            }
            return;
        }

        if (url.includes('lesson-info')) {
            uiLog('命中 lesson-info 接口');
            handleLessonInfo(json);
            return;
        }

        if (url.includes('/lesson/presentation/fetch')) {
            uiLog('命中 fetch 接口');
            handleFetch(json);
        }
    }

    // ==================== 视频 URL 拦截 ====================
    /**
     * 判断 URL 是否为已知的视频回放地址。
     */
    function isVideoUrl(url) {
        if (typeof url !== 'string') return false;
        return CONFIG.VIDEO_SOURCES.some(src => url.includes(src.host + src.pathPrefix));
    }

    /**
     * 从视频 URL 中提取文件名。
     * 例如: /liveRecordLive/xxx/ks_1685828084477451648.xxx.mp4?auth_key=...
     *       /origin/tx_1688056942261951872/1758991350692480607-xxx.mp4?auth_key=...
     * 提取最后的 .mp4 文件名。
     */
    function extractVideoFilename(url) {
        try {
            // 去掉查询参数
            const urlWithoutQuery = url.split('?')[0];
            // 取最后一段作为文件名
            const segments = urlWithoutQuery.split('/');
            let filename = segments[segments.length - 1];
            // 确保有 .mp4 后缀
            if (!filename.endsWith('.mp4')) {
                filename += '.mp4';
            }
            return filename;
        } catch (e) {
            return 'video_' + Date.now() + '.mp4';
        }
    }

    /**
     * 从视频 URL 路径中提取 presentationId（ks_ 或 tx_ 前缀的数字串）。
     * 例如: /liveRecordLive/xxx/ks_1685828084477451648.xxx.mp4
     *       /origin/tx_1688056942261951872/1758991350692480607-xxx.mp4
     * 提取: ks_1685828084477451648 或 tx_1688056942261951872
     */
    function extractPresentationIdFromVideoUrl(url) {
        try {
            // 匹配 ks_ 或 tx_ 后跟数字
            const match = url.match(/((?:ks|tx)_\d+)/);
            return match ? match[1] : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 捕获视频 URL 时的上下文查询。
     * 优先级：
     * 1. 当前 activeLesson（最近捕获的课件上下文，视频总是在课件之后加载）
     * 2. 通过 presentationId 精确匹配（ks_/tx_ 前缀或纯数字）
     * 3. 遍历所有已知上下文模糊匹配
     */
    function getVideoContext(videoUrl) {
        // 优先级 1：最近课件上下文（最可靠）
        if (STATE.activeLesson) {
            return STATE.activeLesson;
        }

        // 优先级 2：从 URL 提取 presentationId 精确匹配
        const presId = extractPresentationIdFromVideoUrl(videoUrl);
        if (presId) {
            // 尝试带前缀匹配
            if (STATE.presentationIdToContext[presId]) {
                return STATE.presentationIdToContext[presId];
            }
            // 去掉 ks_/tx_ 前缀后匹配纯数字 ID
            const numericPart = presId.replace(/^(?:ks|tx)_/, '');
            if (numericPart && STATE.presentationIdToContext[numericPart]) {
                return STATE.presentationIdToContext[numericPart];
            }
        }

        // 优先级 3：遍历模糊匹配
        for (const [pid, ctx] of Object.entries(STATE.presentationIdToContext)) {
            if (videoUrl.includes(pid)) {
                return ctx;
            }
        }
        return null;
    }

    /**
     * 处理捕获到的视频 URL：加入待确认列表。
     */
    function handleVideoUrl(videoUrl) {
        // 排除重复（基于完整 URL 去重）
        const key = 'video:' + videoUrl;
        if (STATE.processedKeys.has(key)) return;
        STATE.processedKeys.add(key);

        // 尝试关联课件上下文来命名
        const ctx = getVideoContext(videoUrl);
        let name;
        if (ctx) {
            name = '[录播] ' + ctx.lessonName + '_' + ctx.teacherName + (ctx.suffix || '');
        } else {
            // 兜底：从 URL 提取文件名
            const filename = extractVideoFilename(videoUrl);
            name = '[录播] ' + filename;
        }

        // 视频下载不需要 source payload，直接用 URL 作为 source
        const headers = {
            'Referer': CONFIG.INDEX_URL,
            'Origin': 'https://pro.yuketang.cn',
        };

        addPendingItem(name, videoUrl, headers, 'video');
    }

    /**
     * 拦截视频元素的 src 设置和 <source> 子元素，
     * 捕获指向 ks-playback.xuetangx.com 的回放视频 URL。
     */
    function setupVideoInterceptor() {
        // 方式一：Hook HTMLMediaElement.prototype.src setter
        try {
            const origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            if (origSrcDescriptor && origSrcDescriptor.set) {
                Object.defineProperty(HTMLMediaElement.prototype, 'src', {
                    get: origSrcDescriptor.get,
                    set: function (value) {
                        if (isVideoUrl(value)) {
                            handleVideoUrl(value);
                        }
                        return origSrcDescriptor.set.call(this, value);
                    },
                    configurable: true,
                });
            }
        } catch (e) {
            console.warn('[雨课堂] 视频 src hook 失败:', e);
        }

        // 方式二：MutationObserver 监听 <video> 下的 <source> 元素变化
        const onDomReady = () => {
            const observer = new MutationObserver(function (mutations) {
                for (const mut of mutations) {
                    for (const node of mut.addedNodes) {
                        // 新增的 <video> 元素
                        if (node.nodeName === 'VIDEO') {
                            checkVideoElement(node);
                        }
                        // 新增的 <source> 元素
                        if (node.nodeName === 'SOURCE') {
                            const src = node.getAttribute('src');
                            if (isVideoUrl(src)) {
                                handleVideoUrl(src);
                            }
                        }
                        // 在子树中搜索
                        if (node.querySelectorAll) {
                            node.querySelectorAll('video').forEach(checkVideoElement);
                            node.querySelectorAll('source').forEach(s => {
                                const src = s.getAttribute('src');
                                if (isVideoUrl(src)) {
                                    handleVideoUrl(src);
                                }
                            });
                        }
                    }
                    // 属性变更：src 属性被直接修改
                    if (mut.type === 'attributes' && mut.attributeName === 'src') {
                        const target = mut.target;
                        if (target.nodeName === 'VIDEO' || target.nodeName === 'SOURCE') {
                            const src = target.nodeName === 'VIDEO' ? target.currentSrc || target.src : target.getAttribute('src');
                            if (isVideoUrl(src)) {
                                handleVideoUrl(src);
                            }
                        }
                    }
                }
            });

            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['src'],
            });

            // 检查已存在的 video 元素
            document.querySelectorAll('video').forEach(checkVideoElement);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onDomReady);
        } else {
            onDomReady();
        }
    }

    function checkVideoElement(video) {
        // 检查 src 属性
        const src = video.currentSrc || video.src;
        if (isVideoUrl(src)) {
            handleVideoUrl(src);
        }
        // 检查 <source> 子元素
        video.querySelectorAll('source').forEach(s => {
            const ssrc = s.getAttribute('src');
            if (isVideoUrl(ssrc)) {
                handleVideoUrl(ssrc);
            }
        });
    }

    // ==================== UI — 日志区 ====================
    function uiLog(msg, type = 'info') {
        const panel = document.getElementById('rc-panel-log');
        if (!panel) return;
        const time = new Date().toLocaleTimeString();
        const line = document.createElement('div');
        line.className = `rc-log-line rc-log-${type}`;
        line.textContent = `[${time}] ${msg}`;
        panel.appendChild(line);
        panel.scrollTop = panel.scrollHeight;
        while (panel.children.length > 200) panel.removeChild(panel.firstChild);
    }

    // ==================== UI — 待确认列表 ====================
    function updatePendingStats() {
        const totalEl = document.getElementById('rc-pending-total');
        const checkedEl = document.getElementById('rc-pending-checked');
        const completedEl = document.getElementById('rc-completed-count');
        if (totalEl) totalEl.textContent = STATE.pendingItems.length;
        if (checkedEl) checkedEl.textContent = STATE.pendingItems.filter(it => it.checked).length;
        if (completedEl) completedEl.textContent = STATE.totalCompleted;
    }

    function renderPendingItem(item) {
        const list = document.getElementById('rc-pending-list');
        if (!list) return;

        const div = document.createElement('div');
        div.className = 'rc-pending-item' + (item.checked ? ' rc-checked' : '');
        div.id = `rc-item-${item.id}`;
        div.innerHTML = `
            <label class="rc-item-label">
                <span class="rc-custom-checkbox">${item.checked ? '☑' : '☐'}</span>
                <input type="checkbox" class="rc-item-checkbox" ${item.checked ? 'checked' : ''} data-id="${item.id}">
                <span class="rc-item-name" title="${item.name}">${item.name}</span>
            </label>
            <button class="rc-item-remove" data-id="${item.id}" title="移除">×</button>
        `;

        // checkbox 事件 — 同时监听 click 和 change
        const cb = div.querySelector('.rc-item-checkbox');
        const customCb = div.querySelector('.rc-custom-checkbox');
        const onToggle = function () {
            const id = parseInt(cb.dataset.id);
            const found = STATE.pendingItems.find(it => it.id === id);
            if (found) found.checked = cb.checked;
            // 切换行高亮
            if (cb.checked) {
                div.classList.add('rc-checked');
                if (customCb) customCb.textContent = '☑';
            } else {
                div.classList.remove('rc-checked');
                if (customCb) customCb.textContent = '☐';
            }
            updatePendingStats();
            updateDownloadBtn();
            saveState();
        };
        cb.addEventListener('change', onToggle);
        // 点击整行也触发切换
        div.addEventListener('click', function (e) {
            // 如果点了移除按钮，不触发切换
            if (e.target.closest('.rc-item-remove')) return;
            cb.checked = !cb.checked;
            onToggle();
        });

        // 移除按钮
        div.querySelector('.rc-item-remove').addEventListener('click', function (e) {
            e.stopPropagation();
            const id = parseInt(this.dataset.id);
            STATE.pendingItems = STATE.pendingItems.filter(it => it.id !== id);
            // 清理对应的 localStorage
            try {
                localStorage.removeItem(STORAGE_SOURCE_PREFIX + id);
                localStorage.removeItem(STORAGE_HEADERS_PREFIX + id);
            } catch (e) {}
            const el = document.getElementById(`rc-item-${id}`);
            if (el) el.remove();
            updatePendingStats();
            updateDownloadBtn();
            saveState();
        });

        list.appendChild(div);
    }

    function removePendingFromUI(id) {
        const el = document.getElementById(`rc-item-${id}`);
        if (el) el.remove();
        STATE.pendingItems = STATE.pendingItems.filter(it => it.id !== id);
        // 清理对应的 localStorage
        try {
            localStorage.removeItem(STORAGE_SOURCE_PREFIX + id);
            localStorage.removeItem(STORAGE_HEADERS_PREFIX + id);
        } catch (e) {}
        updatePendingStats();
        saveState();
    }

    function refreshPendingUI() {
        updatePendingStats();
        updateDownloadBtn();

        const taskEl = document.getElementById('rc-current-task');
        if (taskEl && STATE.currentTask) {
            const t = STATE.currentTask;
            if (t.total > 1 || t.downloaded > 10) {
                // 视频下载：显示 MB
                taskEl.textContent = `${t.name} (${t.downloaded}MB / ${t.total}MB)`;
            } else {
                taskEl.textContent = `${t.name} (${t.downloaded}/${t.total})`;
            }
        } else if (taskEl) {
            taskEl.textContent = '空闲';
        }
    }

    function updateDownloadBtn() {
        const btn = document.getElementById('rc-btn-download');
        if (!btn) return;
        const checkedCount = STATE.pendingItems.filter(it => it.checked).length;
        btn.disabled = checkedCount === 0 || STATE.isProcessing;
        btn.textContent = STATE.isProcessing
            ? '下载中...'
            : `下载选中 (${checkedCount})`;
    }

    // ==================== 操作按钮逻辑 ====================
    function onSelectAll() {
        STATE.pendingItems.forEach(it => { it.checked = true; });
        document.querySelectorAll('.rc-item-checkbox').forEach(cb => { cb.checked = true; });
        document.querySelectorAll('.rc-pending-item').forEach(div => { div.classList.add('rc-checked'); });
        document.querySelectorAll('.rc-custom-checkbox').forEach(span => { span.textContent = '☑'; });
        updatePendingStats();
        updateDownloadBtn();
        saveState();
    }

    function onDeselectAll() {
        STATE.pendingItems.forEach(it => { it.checked = false; });
        document.querySelectorAll('.rc-item-checkbox').forEach(cb => { cb.checked = false; });
        document.querySelectorAll('.rc-pending-item').forEach(div => { div.classList.remove('rc-checked'); });
        document.querySelectorAll('.rc-custom-checkbox').forEach(span => { span.textContent = '☐'; });
        updatePendingStats();
        updateDownloadBtn();
        saveState();
    }

    function onClearAll() {
        STATE.pendingItems = [];
        document.getElementById('rc-pending-list').innerHTML = '';
        updatePendingStats();
        updateDownloadBtn();
        clearStorage();
    }

    function onDownloadSelected() {
        const selected = STATE.pendingItems.filter(it => it.checked);
        if (selected.length === 0) return;

        STATE.downloadQueue = [...selected];
        STATE.pendingItems = STATE.pendingItems.filter(it => !it.checked);

        // 从 UI 移除已选中的项（将在队列处理时逐个移除）
        selected.forEach(item => {
            const el = document.getElementById(`rc-item-${item.id}`);
            if (el) el.style.opacity = '0.4';
        });

        updatePendingStats();
        updateDownloadBtn();
        saveState();
        processDownloadQueue();
    }

    // ==================== UI 面板创建 ====================
    function createUIPanel() {
        const panelHTML = `
        <div id="rc-panel-container">
            <div id="rc-panel-header">
                <span>📥 雨课堂课件下载器</span>
                <div>
                    <button id="rc-btn-minimize" title="最小化">_</button>
                    <button id="rc-btn-close" title="关闭">×</button>
                </div>
            </div>
            <div id="rc-panel-body">
                <!-- 统计栏 -->
                <div id="rc-status-bar">
                    <span>待确认: <strong id="rc-pending-total">0</strong></span>
                    <span>已选: <strong id="rc-pending-checked">0</strong></span>
                    <span>已完成: <strong id="rc-completed-count">0</strong></span>
                </div>
                <!-- 当前任务 -->
                <div id="rc-task-bar">
                    当前: <span id="rc-current-task">空闲</span>
                </div>
                <!-- 待确认列表 -->
                <div id="rc-pending-area">
                    <div id="rc-pending-list"></div>
                    <div id="rc-pending-empty">等待捕获课件接口...</div>
                </div>
                <!-- 操作按钮 -->
                <div id="rc-action-bar">
                    <button id="rc-btn-select-all">全选</button>
                    <button id="rc-btn-deselect-all">取消全选</button>
                    <button id="rc-btn-download" disabled>下载选中 (0)</button>
                    <button id="rc-btn-clear-all">清空列表</button>
                </div>
                <!-- 日志区 -->
                <div id="rc-log-header">📋 日志</div>
                <div id="rc-panel-log"></div>
            </div>
        </div>`;

        const container = document.createElement('div');
        container.innerHTML = panelHTML;
        document.body.appendChild(container.firstElementChild);

        // 按钮事件绑定
        document.getElementById('rc-btn-minimize').addEventListener('click', () => {
            const body = document.getElementById('rc-panel-body');
            body.style.display = body.style.display === 'none' ? 'flex' : 'none';
        });
        document.getElementById('rc-btn-close').addEventListener('click', () => {
            document.getElementById('rc-panel-container').style.display = 'none';
        });
        document.getElementById('rc-btn-select-all').addEventListener('click', onSelectAll);
        document.getElementById('rc-btn-deselect-all').addEventListener('click', onDeselectAll);
        document.getElementById('rc-btn-download').addEventListener('click', onDownloadSelected);
        document.getElementById('rc-btn-clear-all').addEventListener('click', onClearAll);

        // 监听 pending 列表变化，控制空状态提示
        const observer = new MutationObserver(() => {
            const list = document.getElementById('rc-pending-list');
            const empty = document.getElementById('rc-pending-empty');
            if (list && empty) {
                empty.style.display = list.children.length === 0 ? 'block' : 'none';
            }
        });
        const list = document.getElementById('rc-pending-list');
        if (list) observer.observe(list, { childList: true });
    }

    function injectStyles() {
        GM_addStyle(`
            #rc-panel-container {
                position: fixed;
                bottom: 16px; right: 16px;
                width: 440px; max-height: 520px;
                background: #1e1e2e; color: #cdd6f4;
                border-radius: 12px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.45);
                z-index: 2147483647;
                font-family: 'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
                font-size: 13px;
                display: flex; flex-direction: column;
                overflow: hidden;
                border: 1px solid #313244;
            }
            #rc-panel-header {
                display: flex; justify-content: space-between; align-items: center;
                padding: 10px 14px; background: #181825;
                border-bottom: 1px solid #313244;
                cursor: move; user-select: none;
                font-weight: 600; font-size: 14px;
            }
            #rc-panel-header button {
                background: none; border: none; color: #a6adc8;
                cursor: pointer; font-size: 16px; padding: 0 4px;
                line-height: 1; border-radius: 4px;
            }
            #rc-panel-header button:hover { background: #313244; color: #cdd6f4; }
            #rc-panel-body {
                flex: 1; display: flex; flex-direction: column; overflow: hidden;
            }
            #rc-status-bar {
                display: flex; justify-content: space-between;
                padding: 6px 14px; background: #181825;
                font-size: 11px; color: #a6adc8;
                border-bottom: 1px solid #313244;
            }
            #rc-task-bar {
                padding: 4px 14px; font-size: 11px;
                color: #89b4fa; background: #1e1e2e;
                border-bottom: 1px solid #313244;
            }
            #rc-pending-area {
                max-height: 180px; overflow-y: auto;
                border-bottom: 1px solid #313244;
            }
            #rc-pending-area::-webkit-scrollbar { width: 4px; }
            #rc-pending-area::-webkit-scrollbar-thumb { background: #45475a; border-radius: 2px; }
            #rc-pending-empty {
                text-align: center; padding: 20px;
                color: #585b70; font-size: 12px;
            }
            .rc-pending-item {
                display: flex; align-items: center;
                padding: 0 8px 0 0;
                border-bottom: 1px solid #31324455;
                border-left: 3px solid transparent;
                transition: background 0.15s, border-color 0.15s;
                cursor: pointer;
                user-select: none;
            }
            .rc-pending-item:hover { background: #31324444; }
            /* 选中态高亮 */
            .rc-pending-item.rc-checked {
                background: #89b4fa18;
                border-left-color: #89b4fa;
            }
            .rc-pending-item.rc-checked:hover {
                background: #89b4fa28;
            }
            .rc-item-label {
                display: flex; align-items: center;
                flex: 1; padding: 6px 6px 6px 10px;
                cursor: pointer; min-width: 0;
            }
            /* 自定义复选框图标 */
            .rc-custom-checkbox {
                font-size: 18px; margin-right: 8px;
                flex-shrink: 0; line-height: 1;
                transition: color 0.15s;
            }
            .rc-pending-item:not(.rc-checked) .rc-custom-checkbox {
                color: #585b70;  /* 未选中：灰色 */
            }
            .rc-pending-item.rc-checked .rc-custom-checkbox {
                color: #89b4fa;  /* 选中：蓝色 */
            }
            /* 隐藏原生复选框 */
            .rc-pending-item .rc-item-checkbox {
                position: absolute; opacity: 0;
                width: 0; height: 0; pointer-events: none;
            }
            .rc-pending-item .rc-item-name {
                flex: 1; overflow: hidden; text-overflow: ellipsis;
                white-space: nowrap; font-size: 12px;
            }
            .rc-pending-item .rc-item-remove {
                background: none; border: none; color: #585b70;
                cursor: pointer; font-size: 14px; padding: 0 4px;
                border-radius: 4px; line-height: 1;
            }
            .rc-pending-item .rc-item-remove:hover { color: #f38ba8; background: #313244; }
            #rc-action-bar {
                display: flex; gap: 6px; padding: 8px 14px;
                background: #181825; border-bottom: 1px solid #313244;
                flex-wrap: wrap;
            }
            #rc-action-bar button {
                padding: 4px 10px; border: 1px solid #45475a;
                border-radius: 6px; background: #313244;
                color: #cdd6f4; font-size: 11px; cursor: pointer;
                transition: background 0.15s, border-color 0.15s;
            }
            #rc-action-bar button:hover:not(:disabled) {
                background: #45475a; border-color: #89b4fa;
            }
            #rc-action-bar button:disabled {
                opacity: 0.4; cursor: not-allowed;
            }
            #rc-btn-download {
                background: #89b4fa22 !important;
                border-color: #89b4fa66 !important;
                color: #89b4fa !important;
                font-weight: 600;
            }
            #rc-btn-download:hover:not(:disabled) {
                background: #89b4fa44 !important;
            }
            #rc-log-header {
                padding: 4px 14px; font-size: 11px;
                color: #585b70; background: #1e1e2e;
            }
            #rc-panel-log {
                flex: 1; overflow-y: auto; padding: 6px 14px;
                font-size: 11px; line-height: 1.6;
                max-height: 120px;
                font-family: 'Cascadia Code','Fira Code','Consolas',monospace;
            }
            #rc-panel-log::-webkit-scrollbar { width: 4px; }
            #rc-panel-log::-webkit-scrollbar-thumb { background: #45475a; border-radius: 2px; }
            .rc-log-line { padding: 1px 0; }
            .rc-log-info  { color: #a6adc8; }
            .rc-log-success { color: #a6e3a1; }
            .rc-log-warn  { color: #fab387; }
            .rc-log-error  { color: #f38ba8; }
            #rc-panel-container.dragging { opacity: 0.85; transition: none; }
        `);
    }

    // 拖拽
    function enableDrag() {
        const panel = document.getElementById('rc-panel-container');
        const header = document.getElementById('rc-panel-header');
        if (!panel || !header) return;
        let ox, oy, dragging = false;
        header.addEventListener('mousedown', e => {
            dragging = true;
            ox = e.clientX - panel.offsetLeft;
            oy = e.clientY - panel.offsetTop;
            panel.classList.add('dragging');
        });
        document.addEventListener('mousemove', e => {
            if (!dragging) return;
            panel.style.left = (e.clientX - ox) + 'px';
            panel.style.top = (e.clientY - oy) + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', () => {
            dragging = false;
            if (panel) panel.classList.remove('dragging');
        });
    }

    // ==================== 初始化 ====================
    function init() {
        injectStyles();
        setupFetchInterceptor();
        setupXHRInterceptor();
        setupStorageListener();   // 监听其他窗口的 localStorage 变更
        setupVideoInterceptor();  // 拦截视频元素加载

        // 在创建 UI 之前先恢复上次会话的状态
        const restored = loadState();

        const onReady = () => {
            createUIPanel();
            enableDrag();

            // 如果有恢复的待确认项，重新渲染
            if (restored && STATE.pendingItems.length > 0) {
                STATE.pendingItems.forEach(item => {
                    renderPendingItem(item);
                });
                updatePendingStats();
                updateDownloadBtn();
                uiLog(`🔄 已恢复 ${STATE.pendingItems.length} 个待确认课件，共完成 ${STATE.totalCompleted} 个`);
            } else {
                uiLog('🚀 雨课堂课件下载器已就绪');
            }
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onReady);
        } else {
            onReady();
        }

        GM_registerMenuCommand('显示/隐藏面板', () => {
            const p = document.getElementById('rc-panel-container');
            if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
        });
        GM_registerMenuCommand('清空已处理记录', () => {
            STATE.processedKeys.clear();
            STATE.totalCompleted = 0;
            STATE.pendingItems = [];
            const list = document.getElementById('rc-pending-list');
            if (list) list.innerHTML = '';
            updatePendingStats();
            updateDownloadBtn();
            clearStorage();
            uiLog('已清空所有记录');
        });
    }

    init();
})();
