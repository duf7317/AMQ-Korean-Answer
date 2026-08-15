// ==UserScript==
// @name         AMQ KR Helper
// @namespace    amq-kr-helper
// @version      1.7.0
// @description  AMQ 원래 입력을 유지하면서 한글/영문/로마자 별칭 검색을 보조합니다.
// @match        https://animemusicquiz.com/*
// @match        https://www.animemusicquiz.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      docs.google.com
// @connect      googleusercontent.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/duf7317/AMQ-Korean-Answer/main/amq-kr-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/duf7317/AMQ-Korean-Answer/main/amq-kr-helper.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '1.7.0';
    const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/19-YDyMy__mPoP5Ozi7nPJ-A83XwsljODhhqmzuv1P2g/export?format=tsv&gid=0';
    const REFRESH_MS = 60_000;
    const MAX_RESULTS = 8;
    const POPUP_ID = 'amqKrHelperAliasPopup';
    const STYLE_ID = 'amqKrHelperV17Style';
    const STORAGE = {
        sheetUrl: 'amqKrHelperSheetUrl',
        rows: 'amqKrHelperRowsV17',
        enabled: 'amqKrHelperEnabled'
    };
    const LEGACY_ROW_KEYS = ['amqKrHelperRowsV16', 'amqKrHelperRows', 'krHelperRows', 'amq_kr_rows'];
    const ANSWER_SELECTORS = ['#qpAnswerInput', '#qpAnswerInput input', 'input.qpAnswerInput', '.qpAnswerInput input'];
    const MULTIPLE_CHOICE_SELECTORS = ['#qpMultipleChoiceContainer .qpMultipleChoiceEntryText', '#qpMultipleChoiceContainer .clickAble', '#qpMultipleChoiceContainer button', '.qpMultipleChoiceAnswer'];

    let rows = [];
    let answerInput = null;
    let popup = null;
    let matches = [];
    let selectedIndex = -1;
    let krKeyboardMode = false;
    let refreshTimer = null;
    let watchTimer = null;
    let observer = null;
    let refreshBusy = false;
    let enabled = loadValue(STORAGE.enabled, true) !== false;
    let lastSubmit = { value: '', at: 0 };

    function loadValue(key, fallback) {
        try {
            const value = typeof GM_getValue === 'function' ? GM_getValue(key, undefined) : undefined;
            if (value !== undefined) return value;
            const raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch (_) { return fallback; }
    }

    function saveValue(key, value) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (_) { /* noop */ }
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* noop */ }
    }

    function normalize(value) {
        return String(value || '')
            .normalize('NFKC')
            .toLocaleLowerCase()
            .replace(/[‐‑‒–—―_\-·・:;,.!?"'`~()[\]{}<>/\\|+*=]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function compact(value) { return normalize(value).replace(/\s/g, ''); }
    function hasHangul(value) { return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value); }
    function tokens(value) { return normalize(value).split(' ').filter(Boolean); }

    function rowValue(raw, names) {
        const wanted = new Set(names.map(name => name.toLowerCase().replace(/[^a-z가-힣]/g, '')));
        for (const [key, value] of Object.entries(raw || {})) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z가-힣]/g, '');
            if (wanted.has(normalizedKey)) return value;
        }
        return '';
    }

    function prepareRow(raw, index) {
        const korean = String(rowValue(raw, ['KoreanAnswer', 'Korean', '한글'])).trim();
        const english = String(rowValue(raw, ['EnglishAnswer', 'EnglishAnsawer', 'English', '영어'])).trim();
        const romaji = String(rowValue(raw, ['RomajiAnswer', 'Romaji', 'Romanji', '로마자'])).trim();
        if (!korean || (!english && !romaji)) return null;
        const item = { id: index, korean, english, romaji };
        item.nKorean = normalize(korean);
        item.nEnglish = normalize(english);
        item.nRomaji = normalize(romaji);
        item.cKorean = compact(korean);
        item.cEnglish = compact(english);
        item.cRomaji = compact(romaji);
        item.search = [item.nKorean, item.nEnglish, item.nRomaji].filter(Boolean).join(' ');
        item.compactSearch = [item.cKorean, item.cEnglish, item.cRomaji].filter(Boolean).join(' ');
        return item;
    }

    function prepareRows(rawRows) {
        const result = [];
        (Array.isArray(rawRows) ? rawRows : []).forEach((raw, sourceIndex) => {
            const koreanRaw = String(rowValue(raw, ['KoreanAnswer', 'Korean', '한글']));
            const aliases = koreanRaw.split(',').map(value => value.trim()).filter(Boolean);
            (aliases.length ? aliases : ['']).forEach((korean, aliasIndex) => {
                const item = prepareRow({ ...raw, KoreanAnswer: korean }, `${sourceIndex}:${aliasIndex}`);
                if (item) result.push(item);
            });
        });
        return result;
    }

    function hydrate(rawRows) {
        rows = prepareRows(rawRows);
    }

    function scoreRow(row, query) {
        const nq = normalize(query);
        const cq = compact(query);
        const qTokens = tokens(query);
        if (!nq || !cq) return null;
        const allTokens = qTokens.every(token => row.search.includes(token) || row.compactSearch.includes(compact(token)));
        const compactIncluded = row.compactSearch.includes(cq);
        if (!allTokens && !compactIncluded) return null;
        let tier = 3;
        if (row.nKorean.startsWith(nq) || row.cKorean.startsWith(cq)) tier = 0;
        else if ([row.nEnglish, row.nRomaji].some(v => v && v.startsWith(nq)) || [row.cEnglish, row.cRomaji].some(v => v && v.startsWith(cq))) tier = 1;
        else if (allTokens) tier = 2;
        const exact = [row.nKorean, row.nEnglish, row.nRomaji, row.cKorean, row.cEnglish, row.cRomaji].includes(nq) || [row.cKorean, row.cEnglish, row.cRomaji].includes(cq);
        return { row, tier, exact: exact ? 0 : 1, length: Math.min(row.korean.length, row.english.length || Infinity, row.romaji.length || Infinity) };
    }

    function search(query) {
        return rows.map(row => scoreRow(row, query)).filter(Boolean)
            .sort((a, b) => a.tier - b.tier || a.exact - b.exact || a.length - b.length || a.row.korean.localeCompare(b.row.korean, 'ko'))
            .slice(0, MAX_RESULTS).map(result => result.row);
    }

    function exactKorean(query) {
        const nq = normalize(query);
        const cq = compact(query);
        return rows.find(row => row.nKorean === nq || row.cKorean === cq) || null;
    }

    function preferredAnswer(row) {
        try {
            if (typeof unsafeWindow !== 'undefined' && unsafeWindow.options) {
                return unsafeWindow.options.useRomajiNames === 1 ? (row.romaji || row.english) : (row.english || row.romaji);
            }
        } catch (_) { /* fall through */ }
        const modeText = [
            document.querySelector('#qpAnswerMode')?.textContent,
            document.querySelector('#qpAnswerMode')?.value,
            document.querySelector('.qpAnswerMode.active')?.textContent,
            document.querySelector('#qpAnimeNameMode')?.textContent
        ].filter(Boolean).join(' ').toLowerCase();
        return modeText.includes('romaji') || modeText.includes('로마') ? (row.romaji || row.english) : (row.english || row.romaji);
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${POPUP_ID}{position:fixed;z-index:2147483646;display:none;width:min(420px,calc(100vw - 16px));max-height:260px;overflow:auto;background:#171b21;border:1px solid #4b596a;border-radius:7px;box-shadow:0 8px 24px #0009;color:#f3f6fa;font:13px/1.3 Arial,sans-serif}
            #${POPUP_ID} .krh-head{padding:5px 9px;color:#9fb0c3;background:#222a34;font-size:11px;border-bottom:1px solid #394451}
            #${POPUP_ID} .krh-item{padding:7px 9px;cursor:pointer;border-bottom:1px solid #2d3641}
            #${POPUP_ID} .krh-item:last-child{border-bottom:0}
            #${POPUP_ID} .krh-item:hover,#${POPUP_ID} .krh-item.sel{background:#315674}
            #${POPUP_ID} .krh-ko{font-weight:700;color:#fff}
            #${POPUP_ID} .krh-target{margin-top:2px;color:#b8c8d8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        `;
        document.head.appendChild(style);
    }

    function ensurePopup() {
        ensureStyle();
        popup = document.getElementById(POPUP_ID);
        if (!popup) {
            popup = document.createElement('div');
            popup.id = POPUP_ID;
            popup.setAttribute('role', 'listbox');
            document.body.appendChild(popup);
        }
        return popup;
    }

    function positionPopup() {
        if (!answerInput || !popup) return;
        const rect = answerInput.getBoundingClientRect();
        popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - Math.min(420, innerWidth - 16) - 8))}px`;
        popup.style.top = `${Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 5)}px`;
        popup.style.width = `${Math.min(Math.max(rect.width, 280), 420)}px`;
    }

    function hidePopup() {
        if (popup) popup.style.display = 'none';
        matches = [];
        selectedIndex = -1;
        krKeyboardMode = false;
    }

    function renderPopup(query) {
        if (!enabled || !answerInput || !query.trim()) return hidePopup();
        matches = search(query);
        if (!matches.length) return hidePopup();
        ensurePopup();
        popup.textContent = '';
        const head = document.createElement('div');
        head.className = 'krh-head';
        head.textContent = 'KR 별칭 · 클릭 또는 Alt+↓ 후 선택';
        popup.appendChild(head);
        matches.forEach((row, index) => {
            const item = document.createElement('div');
            item.className = `krh-item${selectedIndex === index ? ' sel' : ''}`;
            item.setAttribute('role', 'option');
            const ko = document.createElement('div');
            ko.className = 'krh-ko';
            ko.textContent = row.korean;
            const target = document.createElement('div');
            target.className = 'krh-target';
            target.textContent = [row.english, row.romaji].filter((v, i, a) => v && a.indexOf(v) === i).join(' · ');
            item.append(ko, target);
            item.addEventListener('mousedown', event => { event.preventDefault(); choose(index); });
            popup.appendChild(item);
        });
        popup.style.display = 'block';
        requestAnimationFrame(positionPopup);
    }

    function dispatchNativeInput(input) {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function submitMapped(row) {
        if (!answerInput || !row) return;
        const value = preferredAnswer(row);
        if (!value) return;
        const now = Date.now();
        if (lastSubmit.value === value && now - lastSubmit.at < 250) return;
        lastSubmit = { value, at: now };
        hidePopup();
        answerInput.value = value;
        dispatchNativeInput(answerInput);
        answerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }

    function choose(index) { submitMapped(matches[index]); }

    function onInput() {
        selectedIndex = -1;
        krKeyboardMode = false;
        renderPopup(answerInput.value);
    }

    function onKeyDown(event) {
        if (event.key === 'ArrowDown' && event.altKey && matches.length) {
            event.preventDefault();
            event.stopImmediatePropagation();
            krKeyboardMode = true;
            selectedIndex = selectedIndex < 0 ? 0 : (selectedIndex + 1) % matches.length;
            return renderPopup(answerInput.value);
        }
        if (krKeyboardMode && matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
            return renderPopup(answerInput.value);
        }
        if (krKeyboardMode && event.key === 'Enter' && selectedIndex >= 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return choose(selectedIndex);
        }
        if (event.key === 'Escape' && krKeyboardMode) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return hidePopup();
        }
        if (event.key !== 'Enter' || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
        const query = answerInput.value.trim();
        if (!hasHangul(query)) return; // 영어/Romaji Enter는 AMQ에 100% 위임
        const exact = exactKorean(query);
        event.preventDefault();
        event.stopImmediatePropagation();
        if (exact) submitMapped(exact); // 한글 정확 일치만 자동 변환
        else renderPopup(query); // 매핑 없는 한글 원문 제출 차단
    }

    function findAnswerInput() {
        for (const selector of ANSWER_SELECTORS) {
            const element = document.querySelector(selector);
            if (element instanceof HTMLInputElement) return element;
        }
        return null;
    }

    function bindInput() {
        const next = findAnswerInput();
        if (!next || next === answerInput) return;
        if (answerInput) {
            answerInput.removeEventListener('input', onInput);
            answerInput.removeEventListener('keydown', onKeyDown, true);
        }
        answerInput = next;
        answerInput.addEventListener('input', onInput);
        answerInput.addEventListener('keydown', onKeyDown, true);
    }

    function replaceMultipleChoice() {
        if (!enabled || !rows.length) return;
        const byAnswer = new Map();
        rows.forEach(row => {
            [row.english, row.romaji].filter(Boolean).forEach(name => byAnswer.set(compact(name), row.korean));
        });
        document.querySelectorAll(MULTIPLE_CHOICE_SELECTORS.join(',')).forEach(element => {
            if (element.dataset.krhOriginalText) return;
            const original = element.textContent.trim();
            const korean = byAnswer.get(compact(original));
            if (!korean) return;
            element.dataset.krhOriginalText = original;
            element.textContent = korean;
            element.title = original;
            element.style.fontSize = korean.length <= 12 ? '18px' : korean.length <= 20 ? '14px' : korean.length <= 28 ? '12px' : '10px';
        });
    }

    function parseCsv(text) {
        if (text.includes('\t')) {
            const lines = text.split(/\r?\n/).filter(line => line.trim());
            if (lines.length < 2) return [];
            const headers = lines.shift().split('\t').map(value => value.replace(/^\uFEFF/, '').trim());
            return lines.map(line => {
                const values = line.split('\t').map(value => value.trim());
                return Object.fromEntries(headers.map((header, index) => [header, values[index] || '']));
            });
        }
        const table = [];
        let row = [], cell = '', quoted = false;
        for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (quoted && ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
            else if (ch === '"') quoted = !quoted;
            else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
            else if ((ch === '\n' || ch === '\r') && !quoted) {
                if (ch === '\r' && text[i + 1] === '\n') i += 1;
                row.push(cell); cell = '';
                if (row.some(value => value.trim())) table.push(row);
                row = [];
            } else cell += ch;
        }
        row.push(cell); if (row.some(value => value.trim())) table.push(row);
        if (table.length < 2) return [];
        const headers = table.shift().map(value => value.replace(/^\uFEFF/, '').trim());
        return table.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
    }

    function requestText(url) {
        const cacheBusted = `${url}${url.includes('?') ? '&' : '?'}_krh=${Date.now()}`;
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url: cacheBusted, headers: { 'Cache-Control': 'no-cache' }, onload: response => response.status >= 200 && response.status < 300 ? resolve(response.responseText) : reject(new Error(`HTTP ${response.status}`)), onerror: reject }));
        }
        return fetch(cacheBusted, { cache: 'no-store' }).then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); });
    }

    function normalizeSheetUrl(url) {
        const value = String(url || '').trim();
        if (!value) return '';
        if (/\/export\?format=csv/i.test(value) || /output=csv/i.test(value)) return value;
        const id = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/)?.[1];
        const gid = value.match(/[?&#]gid=(\d+)/)?.[1] || '0';
        return id ? `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}` : value;
    }

    async function refreshSheet() {
        if (refreshBusy) return;
        const url = normalizeSheetUrl(loadValue(STORAGE.sheetUrl, DEFAULT_SHEET_URL));
        if (!url) return;
        refreshBusy = true;
        try {
            const parsed = parseCsv(await requestText(url));
            const prepared = prepareRows(parsed);
            if (prepared.length) {
                rows = prepared;
                saveValue(STORAGE.rows, parsed);
                replaceMultipleChoice();
                if (answerInput?.value) renderPopup(answerInput.value);
            }
        } catch (error) { console.warn('[AMQ KR Helper] 시트 갱신 실패, 캐시 유지:', error); }
        finally { refreshBusy = false; }
    }

    function restoreRows() {
        const own = loadValue(STORAGE.rows, null);
        if (Array.isArray(own) && own.length) return hydrate(own);
        for (const key of LEGACY_ROW_KEYS) {
            const legacy = loadValue(key, null);
            if (Array.isArray(legacy) && legacy.length) { hydrate(legacy); saveValue(STORAGE.rows, legacy); return; }
        }
    }

    function configureMenu() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('KR Helper 시트 URL 설정', () => {
            const current = loadValue(STORAGE.sheetUrl, DEFAULT_SHEET_URL);
            const value = prompt('Google Sheet 공유 URL 또는 CSV URL을 입력하세요.\n필수 열: KoreanAnswer, EnglishAnswer, Romaji', current);
            if (value === null) return;
            saveValue(STORAGE.sheetUrl, normalizeSheetUrl(value));
            refreshSheet();
        });
        GM_registerMenuCommand(enabled ? 'KR Helper 끄기' : 'KR Helper 켜기', () => {
            enabled = !enabled; saveValue(STORAGE.enabled, enabled); if (!enabled) hidePopup(); else refreshSheet();
        });
        GM_registerMenuCommand('KR Helper 지금 새로고침', refreshSheet);
    }

    function ensureToggle() {
        const current = document.getElementById('krHelperToggle');
        if (current?.isConnected) {
            const checkbox = current.querySelector('input');
            if (checkbox) checkbox.checked = enabled;
            return;
        }
        const container = document.getElementById('menuBarOptionContainer');
        if (!container?.parentElement) return;
        const label = document.createElement('label');
        label.id = 'krHelperToggle';
        label.style.cssText = 'display:inline-flex;align-items:center;margin-right:8px;cursor:pointer;user-select:none;font-size:12px';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox'; checkbox.checked = enabled; checkbox.style.marginRight = '4px';
        checkbox.addEventListener('change', () => {
            enabled = checkbox.checked; saveValue(STORAGE.enabled, enabled);
            if (!enabled) hidePopup(); else { refreshSheet(); if (answerInput?.value) renderPopup(answerInput.value); }
        });
        label.append(checkbox, document.createTextNode('KR Helper'));
        container.parentElement.insertBefore(label, container);
    }

    function start() {
        restoreRows();
        configureMenu();
        ensurePopup();
        bindInput();
        replaceMultipleChoice();
        refreshSheet();
        if (!refreshTimer) refreshTimer = setInterval(refreshSheet, REFRESH_MS);
        if (!watchTimer) watchTimer = setInterval(() => { ensureToggle(); bindInput(); replaceMultipleChoice(); }, 300);
        if (!observer) {
            let scheduled = false;
            observer = new MutationObserver(() => {
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => { scheduled = false; bindInput(); replaceMultipleChoice(); });
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        addEventListener('resize', positionPopup, { passive: true });
        document.addEventListener('mousedown', event => { if (popup && !popup.contains(event.target) && event.target !== answerInput) hidePopup(); });
        console.info(`[AMQ KR Helper] v${VERSION} ready (${rows.length} cached aliases)`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
