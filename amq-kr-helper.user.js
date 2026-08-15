// ==UserScript==
// @name         AMQ KR Helper
// @namespace    amq-kr-helper
// @version      1.9.0
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
// @updateURL    https://raw.githubusercontent.com/duf7317/AMQ-Korean-Answer/refs/heads/main/amq-kr-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/duf7317/AMQ-Korean-Answer/refs/heads/main/amq-kr-helper.user.js
// ==/UserScript==

(() => {
    'use strict';

    const VERSION = '1.9.0';
    const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/19-YDyMy__mPoP5Ozi7nPJ-A83XwsljODhhqmzuv1P2g/export?format=tsv&gid=0';
    const REFRESH_MS = 60_000;
    const MAX_KR_RESULTS = 50;
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
    let bypassNextEnter = false;
    let renderSerial = 0;
    let renderTimers = [];
    let lastKrQuery = '';
    let lastKrMatches = [];
    let lastRenderSignature = '';
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
            const english = rowValue(raw, ['EnglishAnswer', 'EnglishAnsawer', 'English', '영어']);
            const romaji = rowValue(raw, ['RomajiAnswer', 'Romaji', 'Romanji', '로마자']);
            const aliases = koreanRaw.split(',').map(value => value.trim()).filter(Boolean);
            (aliases.length ? aliases : ['']).forEach((korean, aliasIndex) => {
                const item = prepareRow({ KoreanAnswer: korean, EnglishAnswer: english, RomajiAnswer: romaji }, `${sourceIndex}:${aliasIndex}`);
                if (item) result.push(item);
            });
        });
        return result;
    }

    function hydrate(rawRows) {
        rows = prepareRows(rawRows);
    }

    function scoreRow(row, context) {
        const { nq, cq, qTokens } = context;
        if (!nq || !cq) return null;
        const allTokens = qTokens.every(token => row.search.includes(token) || row.compactSearch.includes(token.replace(/\s/g, '')));
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
        const nq = normalize(query);
        const context = { nq, cq: nq.replace(/\s/g, ''), qTokens: nq.split(' ').filter(Boolean) };
        const compare = (a, b) => a.tier - b.tier || a.exact - b.exact || a.length - b.length || a.row.korean.localeCompare(b.row.korean, 'ko');
        const best = [];
        for (const row of rows) {
            const result = scoreRow(row, context);
            if (!result) continue;
            best.push(result);
            best.sort(compare);
            if (best.length > MAX_KR_RESULTS) best.pop();
        }
        return best.map(result => result.row);
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
            #${POPUP_ID}{position:fixed;z-index:2147483646;display:none;box-sizing:border-box;margin:0;padding:0;max-height:260px;overflow-y:auto;overflow-x:hidden;list-style:none;background:#fff;border:1px solid rgba(0,0,0,.3);border-radius:0 0 4px 4px;box-shadow:0 2px 4px rgba(0,0,0,.2);color:#333;font:14px/1.35 Arial,sans-serif;text-align:left}
            #${POPUP_ID} .krh-item{display:block;margin:0;padding:6px 9px;cursor:pointer;border:0;white-space:normal;color:#333;background:#fff}
            #${POPUP_ID} .krh-item:hover,#${POPUP_ID} .krh-item.sel{background:#3b78b4;color:#fff}
            #${POPUP_ID} .krh-title{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            #${POPUP_ID} .krh-target{display:block;margin-top:1px;color:#777;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
            #${POPUP_ID} .krh-item:hover .krh-target,#${POPUP_ID} .krh-item.sel .krh-target{color:#e7f1fb}
            .awesomplete ul[role="listbox"] > li[data-krh="true"]{white-space:normal}
        `;
        document.head.appendChild(style);
    }

    function ensurePopup() {
        ensureStyle();
        popup = document.getElementById(POPUP_ID);
        if (!popup) {
            popup = document.createElement('ul');
            popup.id = POPUP_ID;
            popup.setAttribute('role', 'listbox');
            document.body.appendChild(popup);
        }
        return popup;
    }

    function positionPopup() {
        if (!answerInput || !popup) return;
        const rect = answerInput.getBoundingClientRect();
        popup.style.left = `${rect.left}px`;
        popup.style.top = `${Math.min(innerHeight - popup.offsetHeight - 8, rect.bottom + 5)}px`;
        popup.style.width = `${rect.width}px`;
    }

    function hidePopup() {
        if (popup) popup.style.display = 'none';
        getNativeLists().forEach(native => {
            native.querySelectorAll('li[data-krh="true"]').forEach(item => item.remove());
            native.querySelectorAll('li[data-krh-native-hidden="true"]').forEach(item => {
                item.style.removeProperty('display');
                delete item.dataset.krhNativeHidden;
            });
        });
        matches = [];
        selectedIndex = -1;
        lastRenderSignature = '';
    }

    function getNativeLists() {
        if (!answerInput) return [];
        const found = new Set();
        const add = list => {
            if (list && list !== popup && list.id !== POPUP_ID) found.add(list);
        };
        const ownerId = answerInput.getAttribute('aria-owns') || answerInput.getAttribute('aria-controls');
        if (ownerId) add(document.getElementById(ownerId));
        answerInput.closest('.awesomplete')?.querySelectorAll('ul').forEach(add);
        answerInput.parentElement?.querySelectorAll(':scope > ul, :scope > .awesomplete ul').forEach(add);
        document.querySelectorAll('.awesomplete ul[role="listbox"]').forEach(list => {
            const wrapper = list.closest('.awesomplete');
            const input = wrapper?.querySelector('input');
            if (input === answerInput) add(list);
        });
        // AMQ 정답창용 Awesomplete 목록이 문서의 다른 위치에 생성되는 버전도 지원한다.
        if (!found.size) {
            const lists = Array.from(document.querySelectorAll('.awesomplete ul[role="listbox"], ul[role="listbox"]'))
                .filter(list => list !== popup && list.id !== POPUP_ID);
            const visible = lists.filter(list => {
                const rect = list.getBoundingClientRect();
                const inputRect = answerInput.getBoundingClientRect();
                return Math.abs(rect.left - inputRect.left) < 20 || Math.abs(rect.top - inputRect.bottom) < 40;
            });
            (visible.length ? visible : lists.length === 1 ? lists : []).forEach(add);
        }
        return Array.from(found);
    }

    function getNativeList() {
        return getNativeLists()[0] || null;
    }

    function nativeCandidates() {
        const output = [];
        const seen = new Set();
        getNativeLists().forEach(list => {
            Array.from(list.querySelectorAll('li:not([data-krh="true"])')).forEach((element, index) => {
                const label = (element.getAttribute('data-value') || element.textContent || '').trim();
                const key = compact(label);
                if (!label || !key || seen.has(key)) return;
                seen.add(key);
                output.push({ type: 'amq', label, target: label, nativeElement: element, order: index });
            });
        });
        return output;
    }

    function buildUnifiedMatches(query, krRows) {
        const result = [];
        const seen = new Set();
        if (!hasHangul(query)) {
            for (const candidate of nativeCandidates()) {
                const key = compact(candidate.target);
                if (!key || seen.has(`amq:${key}`)) continue;
                seen.add(`amq:${key}`);
                result.push(candidate);
            }
        }
        for (const row of krRows) {
            const target = preferredAnswer(row);
            const key = `${compact(row.korean)}:${compact(target)}`;
            if (!target || seen.has(`kr:${key}`)) continue;
            seen.add(`kr:${key}`);
            result.push({ type: 'kr', label: row.korean, target, row });
        }
        // AMQ가 제공한 원본 후보는 하나도 자르지 않고, 정렬된 KR 후보만 추가한다.
        return result;
    }

    function renderPopup(query, krRows = null, force = false) {
        if (!enabled || !answerInput || !query.trim()) return hidePopup();
        const normalizedQuery = normalize(query);
        if (!krRows) {
            if (normalizedQuery !== lastKrQuery) {
                lastKrQuery = normalizedQuery;
                lastKrMatches = search(query);
            }
            krRows = lastKrMatches;
        }
        const lists = getNativeLists();
        const list = lists[0];
        if (!list) return;
        lists.forEach(native => native.querySelectorAll('li[data-krh="true"]').forEach(item => item.remove()));

        const koreanQuery = hasHangul(query);
        const native = nativeCandidates();
        native.forEach(candidate => {
            if (koreanQuery) {
                candidate.nativeElement.style.setProperty('display', 'none', 'important');
                candidate.nativeElement.dataset.krhNativeHidden = 'true';
            } else if (candidate.nativeElement.dataset.krhNativeHidden === 'true') {
                candidate.nativeElement.style.removeProperty('display');
                delete candidate.nativeElement.dataset.krhNativeHidden;
            }
        });

        const krCandidates = krRows.map(row => ({ type: 'kr', label: row.korean, target: preferredAnswer(row), row }));
        krCandidates.forEach(candidate => {
            const item = document.createElement('li');
            item.dataset.krh = 'true';
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', 'false');
            item.textContent = candidate.label;
            item.title = candidate.target;
            candidate.nativeElement = item;
            item.addEventListener('mousedown', event => {
                event.preventDefault();
                event.stopImmediatePropagation();
                submitValue(candidate.target);
            }, true);
            list.appendChild(item);
        });

        matches = koreanQuery ? krCandidates : native.filter(candidate => candidate.nativeElement.style.display !== 'none').concat(krCandidates);
        if (!matches.length) return;
        if (selectedIndex >= matches.length) selectedIndex = -1;
        matches.forEach((candidate, index) => candidate.nativeElement?.setAttribute('aria-selected', selectedIndex === index ? 'true' : 'false'));
        list.hidden = false;
        list.removeAttribute('hidden');
        const signature = `${selectedIndex}|${matches.map(candidate => `${candidate.type}:${candidate.label}:${candidate.target}`).join('|')}`;
        lastRenderSignature = signature;
    }

    function dispatchNativeInput(input) {
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function submitValue(value) {
        if (!answerInput || !value) return;
        if (!value) return;
        const now = Date.now();
        if (lastSubmit.value === value && now - lastSubmit.at < 250) return;
        lastSubmit = { value, at: now };
        hidePopup();
        answerInput.value = value;
        dispatchNativeInput(answerInput);
        renderSerial += 1;
        renderTimers.forEach(clearTimeout);
        renderTimers = [];
        bypassNextEnter = true;
        setTimeout(() => {
            answerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            answerInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }, 20);
    }

    function choose(index) {
        const candidate = matches[index];
        if (!candidate) return;
        submitValue(candidate.target);
    }

    function queueRender() {
        const serial = ++renderSerial;
        renderTimers.forEach(clearTimeout);
        renderTimers = [];
        const query = answerInput?.value || '';
        if (!query.trim()) return hidePopup();
        renderTimers.push(setTimeout(() => {
            if (serial !== renderSerial || !answerInput) return;
            const current = answerInput.value;
            lastKrQuery = normalize(current);
            lastKrMatches = search(current); // 키 입력당 시트 전체 검색은 여기서 한 번만
            selectedIndex = -1;
            renderPopup(current, lastKrMatches, true);
        }, 24));
        renderTimers.push(setTimeout(() => {
            if (serial !== renderSerial || !answerInput?.value) return;
            // AMQ 후보가 비동기로 늦게 만들어져도 KR 검색은 다시 하지 않고 병합만 갱신한다.
            renderPopup(answerInput.value, lastKrMatches);
        }, 90));
    }

    function onInput() {
        queueRender();
    }

    function onKeyDown(event) {
        if (bypassNextEnter && event.key === 'Enter') {
            bypassNextEnter = false;
            return;
        }
        const nativeList = getNativeList();
        const visible = !!nativeList && !nativeList.hidden && matches.length > 0;
        if (visible && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (selectedIndex < 0) selectedIndex = event.key === 'ArrowDown' ? 0 : matches.length - 1;
            else selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
            return renderPopup(answerInput.value, lastKrMatches, true);
        }
        if (visible && event.key === 'Enter' && selectedIndex >= 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return choose(selectedIndex);
        }
        if (visible && event.key === 'Escape') {
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
        if (exact) submitValue(preferredAnswer(exact)); // 한글 정확 일치만 자동 변환
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
            answerInput.closest('.awesomplete')?.classList.remove('krh-answer-wrapper');
        }
        answerInput = next;
        answerInput.closest('.awesomplete')?.classList.add('krh-answer-wrapper');
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
                lastKrQuery = '';
                lastKrMatches = [];
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
        bindInput();
        replaceMultipleChoice();
        refreshSheet();
        if (!refreshTimer) refreshTimer = setInterval(refreshSheet, REFRESH_MS);
        if (!watchTimer) watchTimer = setInterval(() => { ensureToggle(); bindInput(); replaceMultipleChoice(); }, 1000);
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
        document.addEventListener('mousedown', event => {
            if (event.target === answerInput) return;
            if (getNativeLists().some(list => list.contains(event.target))) return;
            hidePopup();
        });
        console.info(`[AMQ KR Helper] v${VERSION} ready (${rows.length} cached aliases)`);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
})();
