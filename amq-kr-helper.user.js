// ==UserScript==
// @name         AMQ KR Helper
// @namespace    amq-kr-helper
// @version      1.10.19
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

    const VERSION = '1.10.19';
    const DEFAULT_SHEET_URL = 'https://docs.google.com/spreadsheets/d/19-YDyMy__mPoP5Ozi7nPJ-A83XwsljODhhqmzuv1P2g/export?format=tsv&gid=0';
    const REFRESH_MS = 60_000;
    const MAX_KR_RESULTS = 50;
    const SEARCH_CACHE_LIMIT = 40;
    const REQUEST_TIMEOUT_MS = 20_000;
    const NATIVE_OBSERVER_OPTIONS = {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['hidden', 'style', 'class']
    };
    const koreanCollator = new Intl.Collator('ko');
    const POPUP_ID = 'amqKrHelperAliasPopup'; // Legacy popup to exclude from native lists.
    const STYLE_ID = 'amqKrHelperV17Style';
    const STORAGE = {
        sheetUrl: 'amqKrHelperSheetUrl',
        rows: 'amqKrHelperRowsV17',
        enabled: 'amqKrHelperEnabled'
    };
    const LEGACY_ROW_KEYS = ['amqKrHelperRowsV16', 'amqKrHelperRows', 'krHelperRows', 'amq_kr_rows'];
    const ANSWER_SELECTORS = ['#qpAnswerInput', '#qpAnswerInput input', 'input.qpAnswerInput', '.qpAnswerInput input'];
    const MULTIPLE_CHOICE_SELECTOR = '#qpMultipleChoiceContainer .qpMultipleChoiceEntryText';

    let rows = [];
    let exactLooseIndex = new Map();
    let exactLiteralIndex = new Map();
    let choiceIndex = new Map();
    const searchCache = new Map();
    let renderFrame = 0;
    let lastRenderedQuery = '';
    let composing = false;
    let dispatchingInput = false;
    let submitSerial = 0;
    let lastSheetText = null;
    let lastSheetUrl = '';
    let renderedList = null;
    let dropdownWanted = false;
    const visibleListDisplay = new WeakMap();
    const activeNativeObservers = new Map();
    const nativeDisplay = new WeakMap();
    let answerInput = null;
    let popup = null;
    let matches = [];
    let selectedIndex = -1;
    let selectionActivated = false;
    let dismissedQuery = '';
    let bypassNextEnter = false;
    let renderSerial = 0;
    let lastKrQuery = '';
    let lastKrMatches = [];
    let amqDropdownEnabled = true;
    const nativeListObservers = new WeakMap();
    let pendingCompositionArrow = 0;
    let refreshTimer = null;
    let watchTimer = null;
    let observer = null;
    let answerStateObserver = null;
    let multipleChoiceObserver = null;
    let observedMultipleChoiceContainer = null;
    let multipleChoiceTimer = null;
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
        try {
            if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
        } catch (_) { /* use local storage when userscript storage fails */ }
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* noop */ }
    }

    function canonicalPunctuationText(value) {
        return String(value || '')
            .normalize('NFKC')
            .toLocaleLowerCase()
            .replace(/[‐‑‒–—―−]/g, '-')
            .replace(/[‘’‚‛]/g, "'")
            .replace(/[“”„‟]/g, '"')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function hasSearchPunctuation(value) {
        return /[^\p{L}\p{N}\s]/u.test(canonicalPunctuationText(value));
    }

    function literalCompact(value) {
        return canonicalPunctuationText(value).replace(/\s+/g, '');
    }

    function looseNormalize(value) {
        return canonicalPunctuationText(value)
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function looseCompact(value) {
        return looseNormalize(value).replace(/\s+/g, '');
    }

    function normalize(value) { return looseNormalize(value); }
    function compact(value) { return looseCompact(value); }
    function hasHangul(value) { return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(value); }

    function amqLikeTextMatches(text, query) {
        const rawQuery = canonicalPunctuationText(query);
        if (!rawQuery) return false;

        // 검색어에 특수문자를 직접 쓴 경우: 공백만 무시하고 특수문자는 그대로 요구한다.
        if (hasSearchPunctuation(query)) {
            const q = literalCompact(query);
            return !!q && literalCompact(text).includes(q);
        }

        // 특수문자를 안 쓴 경우: AMQ처럼 공백/구두점 차이는 느슨하게 허용한다.
        const nq = looseNormalize(query);
        const cq = looseCompact(query);
        if (!cq) return false;
        const nt = looseNormalize(text);
        const ct = looseCompact(text);
        const qTokens = nq.split(' ').filter(Boolean);
        return ct.includes(cq) || qTokens.every(token => nt.includes(token) || ct.includes(token));
    }

    function searchCacheKey(value) {
        // Token boundaries matter: "ab c" and "a bc" have different matches.
        return hasSearchPunctuation(value)
            ? `punct:${literalCompact(value)}`
            : `loose:${looseNormalize(value)}`;
    }

    function rowValue(raw, names) {
        const wanted = new Set(names.map(name => name.toLowerCase().replace(/[^a-z가-힣]/g, '')));
        for (const [key, value] of Object.entries(raw || {})) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z가-힣]/g, '');
            if (wanted.has(normalizedKey)) return value;
        }
        return '';
    }

    function prepareRow(raw, index) {
        const korean = String(raw.KoreanAnswer || '').trim();
        const english = String(raw.EnglishAnswer || '').trim();
        const romaji = String(raw.RomajiAnswer || '').trim();
        if (!korean || (!english && !romaji)) return null;
        const nKorean = normalize(korean);
        const pKorean = literalCompact(korean);
        const cKorean = nKorean.replace(/\s+/g, '');
        return {
            id: index, korean, english, romaji, nKorean, pKorean, cKorean,
            // Keep punctuation in identity keys: e.g. A-B and AB may be different titles.
            targetKey: JSON.stringify([canonicalPunctuationText(english), canonicalPunctuationText(romaji)]),
            length: Math.min(korean.length, english.length || Infinity, romaji.length || Infinity)
        };
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

    function hydrate(rawRows, prepared = prepareRows(rawRows)) {
        rows = prepared;
        exactLooseIndex = new Map();
        exactLiteralIndex = new Map();
        choiceIndex = new Map();
        searchCache.clear();
        lastKrQuery = '';
        lastKrMatches = [];
        const add = (index, key, row) => {
            if (!key) return;
            let targets = index.get(key);
            if (!targets) index.set(key, targets = new Map());
            if (!targets.has(row.targetKey)) targets.set(row.targetKey, row);
        };
        for (const row of rows) {
            add(exactLooseIndex, row.cKorean, row);
            add(exactLiteralIndex, row.pKorean, row);
            for (const name of [row.english, row.romaji]) {
                add(choiceIndex, canonicalPunctuationText(name), row);
            }
        }
    }

    function scoreRow(row, context) {
        const { nq, cq, qTokens, punctuationQuery, literalQuery } = context;
        if ((!nq || !cq) && !literalQuery) return null;

        // 사용자가 어떤 특수문자든 직접 입력한 경우에는 그 기호를 실제 문자열에서 요구한다.
        if (punctuationQuery) {
            const haystack = row.pKorean || literalCompact(row.korean);
            if (!haystack.includes(literalQuery)) return null;
            const exact = haystack === literalQuery;
            const tier = haystack.startsWith(literalQuery) ? 0 : 1;
            return {
                row,
                tier,
                exact: exact ? 0 : 1,
                length: row.length
            };
        }

        // 일반 검색은 공백/구두점 차이를 느슨하게 허용하고, 공백을 생략해도 찾을 수 있게 유지한다.
        const allTokens = qTokens.every(token => row.nKorean.includes(token) || row.cKorean.includes(token));
        const compactIncluded = row.cKorean.includes(cq);
        if (!allTokens && !compactIncluded) return null;
        let tier = 2;
        if (row.nKorean.startsWith(nq) || row.cKorean.startsWith(cq)) tier = 0;
        else if (allTokens) tier = 1;
        const exact = row.nKorean === nq || row.cKorean === cq;
        return { row, tier, exact: exact ? 0 : 1, length: row.length };
    }

    function search(query) {
        const key = searchCacheKey(query);
        if (searchCache.has(key)) {
            const cached = searchCache.get(key);
            searchCache.delete(key);
            searchCache.set(key, cached);
            return cached;
        }
        const punctuationQuery = hasSearchPunctuation(query);
        const nq = normalize(query);
        const context = {
            nq, cq: nq.replace(/\s+/g, ''), qTokens: nq.split(' ').filter(Boolean),
            punctuationQuery, literalQuery: punctuationQuery ? literalCompact(query) : ''
        };
        const compare = (a, b) => a.tier - b.tier || a.exact - b.exact || a.length - b.length || koreanCollator.compare(a.row.korean, b.row.korean);
        const best = [];
        for (const row of rows) {
            const result = scoreRow(row, context);
            if (!result) continue;
            if (best.length === MAX_KR_RESULTS && compare(result, best[best.length - 1]) >= 0) continue;
            let lo = 0, hi = best.length;
            while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (compare(result, best[mid]) < 0) hi = mid;
                else lo = mid + 1;
            }
            best.splice(lo, 0, result);
            if (best.length > MAX_KR_RESULTS) best.pop();
        }
        const result = best.map(entry => entry.row);
        searchCache.set(key, result);
        if (searchCache.size > SEARCH_CACHE_LIMIT) searchCache.delete(searchCache.keys().next().value);
        return result;
    }

    function exactKorean(query) {
        const index = hasSearchPunctuation(query) ? exactLiteralIndex : exactLooseIndex;
        const key = hasSearchPunctuation(query) ? literalCompact(query) : compact(query);
        const candidates = index.get(key);
        // Never silently select the first anime when an alias has multiple targets.
        return candidates?.size === 1 ? candidates.values().next().value : null;
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
            .awesomplete ul[role="listbox"].krh-korean-query > li:not([data-krh="true"]),
            ul[role="listbox"].krh-korean-query > li:not([data-krh="true"]){display:none!important}
            #qpMultipleChoiceContainer .qpMultipleChoiceEntryTextContainer .qpMultipleChoiceEntryText{overflow:visible!important;white-space:normal!important;word-break:keep-all!important;line-height:1.15!important}
        `;
        document.head.appendChild(style);
    }

    function isAnswerInputActive(input = answerInput) {
        if (!input?.isConnected || input.disabled || input.readOnly) return false;
        if (!input.getClientRects().length) return false;
        const style = getComputedStyle(input);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return true;
    }

    function nativeAutocompleteInstances(input = answerInput) {
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
            const instances = page.Awesomplete?.all || window.Awesomplete?.all;
            return Array.isArray(instances) ? instances.filter(instance => instance.input === input) : [];
        } catch (_) { return []; }
    }

    function clearNativeSelection(lists = getNativeLists()) {
        // Native Awesomplete indexes its own suggestions array. Helper items are
        // display entries only, so AMQ must never retain an index into those items.
        for (const instance of nativeAutocompleteInstances()) {
            if (lists.includes(instance.ul)) instance.index = -1;
        }
        if (answerInput?.getAttribute('aria-activedescendant')) answerInput.setAttribute('aria-activedescendant', '');
    }

    function closeNativeAutocomplete(lists) {
        for (const instance of nativeAutocompleteInstances()) {
            if (!lists.includes(instance.ul)) continue;
            try { instance.close({ reason: 'kr-helper' }); }
            catch (error) { console.warn('[AMQ KR Helper] 자동완성 닫기 실패:', error); }
            // close() may return early when the widget already considers itself closed.
            instance.index = -1;
        }
        if (answerInput?.getAttribute('aria-expanded') === 'true') answerInput.setAttribute('aria-expanded', 'false');
        clearNativeSelection(lists);
    }

    function hidePopup(closeNative = false) {
        dropdownWanted = false;
        if (renderFrame) cancelAnimationFrame(renderFrame);
        renderFrame = 0;
        renderSerial += 1;
        if (popup) popup.style.display = 'none';
        const lists = getNativeLists();
        const resume = pauseNativeObservers(lists);
        try {
            if (closeNative) closeNativeAutocomplete(lists);
            else clearNativeSelection(lists);
            lists.forEach(native => {
                native.classList.remove('krh-korean-query');
                native.querySelectorAll('li[data-krh="true"]').forEach(item => item.remove());
                native.querySelectorAll('li[data-krh-native-hidden="true"]').forEach(restoreNativeDisplay);
                if (closeNative && !native.hidden) native.hidden = true;
            });
        } finally { resume(); }
        matches = [];
        selectedIndex = -1;
        selectionActivated = false;
        lastRenderedQuery = '';
        renderedList = null;
    }

    function pauseNativeObservers(lists) {
        const paused = lists.map(list => [list, activeNativeObservers.get(list)]).filter(([, observer]) => observer);
        paused.forEach(([, observer]) => observer.disconnect());
        return () => paused.forEach(([list, observer]) => {
            if (activeNativeObservers.get(list) === observer) observer.observe(list, NATIVE_OBSERVER_OPTIONS);
        });
    }

    function restoreNativeDisplay(element) {
        const original = nativeDisplay.get(element);
        if (original?.value) element.style.setProperty('display', original.value, original.priority);
        else element.style.removeProperty('display');
        nativeDisplay.delete(element);
        delete element.dataset.krhNativeHidden;
    }

    function setAmqDropdownEnabled(value) {
        if (amqDropdownEnabled === value) return;
        amqDropdownEnabled = value;
        if (!value) hidePopup();
        else if (enabled && answerInput?.value) queueRender();
        console.info(`[AMQ KR Helper] AMQ dropdown ${value ? 'enabled' : 'disabled'}`);
    }

    function detectDropdownCommandState(node) {
        // Do not interpret old chat history or another player's quoted sentence
        // as the current setting. Only newly added complete command notices count.
        const text = String(node?.textContent || '').trim();
        const command = /^dropdown\s+(enabled|disabled)[.!]?$/i.exec(text);
        if (command) setAmqDropdownEnabled(command[1].toLowerCase() === 'enabled');
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

    function mutationContainsNativeCandidate(mutation) {
        const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
        if (target?.closest('li[data-krh="true"]')) return false;
        if ([...mutation.removedNodes].some(node => node.nodeType === 1 && node.matches('li[data-krh="true"]'))) return true;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(node => {
            if (!(node instanceof Element)) return String(node.textContent || '').trim().length > 0;
            if (node.matches('li[data-krh="true"]') || node.closest('li[data-krh="true"]')) return false;
            return node.matches('li') || !!node.querySelector('li:not([data-krh="true"])');
        });
    }

    function observeNativeLists(lists = getNativeLists()) {
        for (const [list, listObserver] of activeNativeObservers) {
            if (!lists.includes(list)) {
                listObserver.disconnect();
                activeNativeObservers.delete(list);
                nativeListObservers.delete(list);
            }
        }
        lists.forEach(list => {
            if (nativeListObservers.has(list)) return;
            const listObserver = new MutationObserver(mutations => {
                const changed = mutations.some(mutation => mutation.type === 'attributes'
                    ? mutation.target === list || mutation.target.matches('li:not([data-krh="true"])')
                    : mutationContainsNativeCandidate(mutation));
                if (!changed || !dropdownWanted || !enabled || !amqDropdownEnabled || !answerInput?.value) return;
                if (hasHangul(answerInput.value)) {
                    // AMQ may close or empty the native list after our input handler.
                    // Repair before the next paint, not on the next arrow key/frame.
                    renderPopup(answerInput.value);
                } else queueRender(false);
            });
            listObserver.observe(list, NATIVE_OBSERVER_OPTIONS);
            nativeListObservers.set(list, listObserver);
            activeNativeObservers.set(list, listObserver);
        });
    }

    function setListVisible(list, visible) {
        const value = list.style.getPropertyValue('display');
        if (value !== 'none') {
            visibleListDisplay.set(list, { value, priority: list.style.getPropertyPriority('display') });
        }
        if (visible && value === 'none') {
            const previous = visibleListDisplay.get(list);
            if (previous?.value) list.style.setProperty('display', previous.value, previous.priority);
            else list.style.removeProperty('display');
        }
        if (list.hidden === visible) list.hidden = !visible;
        const expanded = visible ? 'true' : 'false';
        if (answerInput?.getAttribute('aria-expanded') !== expanded) answerInput.setAttribute('aria-expanded', expanded);
    }

    function nativeCandidates(lists = getNativeLists()) {
        const output = [];
        const seen = new Set();
        lists.forEach(list => {
            Array.from(list.querySelectorAll('li:not([data-krh="true"])')).forEach((element, index) => {
                const label = (element.getAttribute('data-value') || element.textContent || '').trim();
                const key = canonicalPunctuationText(label);
                if (!label || !key || seen.has(key)) return;
                seen.add(key);
                output.push({ type: 'amq', label, target: label, nativeElement: element, order: index });
            });
        });
        return output;
    }

    function syncNativeCandidateVisibility(lists, query) {
        const koreanQuery = hasHangul(query);
        const punctuationQuery = hasSearchPunctuation(query);
        for (const list of lists) {
            for (const element of list.querySelectorAll('li:not([data-krh="true"])')) {
                const label = (element.getAttribute('data-value') || element.textContent || '').trim();
                const filtered = koreanQuery || (punctuationQuery && !amqLikeTextMatches(label, query));
                if (filtered) {
                    if (element.dataset.krhNativeHidden !== 'true') {
                        nativeDisplay.set(element, {
                            value: element.style.getPropertyValue('display'),
                            priority: element.style.getPropertyPriority('display')
                        });
                        element.dataset.krhNativeHidden = 'true';
                    }
                    // Reapply only when needed: late AMQ/theme writes must not
                    // expose stale candidates or cause a mutation observer loop.
                    if (element.style.getPropertyValue('display') !== 'none' ||
                        element.style.getPropertyPriority('display') !== 'important') {
                        element.style.setProperty('display', 'none', 'important');
                    }
                } else if (element.dataset.krhNativeHidden === 'true') restoreNativeDisplay(element);
            }
        }
    }

    function scrollSelectionIntoView(list, element) {
        if (!list || !element) return;
        const itemTop = element.offsetTop;
        const itemBottom = itemTop + element.offsetHeight;
        const viewTop = list.scrollTop;
        const viewBottom = viewTop + list.clientHeight;
        if (itemTop < viewTop) list.scrollTop = itemTop;
        else if (itemBottom > viewBottom) list.scrollTop = itemBottom - list.clientHeight;
    }

    function updateKeyboardSelection(list) {
        matches.forEach((candidate, index) => {
            const element = candidate.nativeElement;
            const value = selectedIndex === index ? 'true' : 'false';
            if (element && element.getAttribute('aria-selected') !== value) element.setAttribute('aria-selected', value);
        });
        if (selectedIndex >= 0) scrollSelectionIntoView(list, matches[selectedIndex]?.nativeElement);
    }

    function renderPopup(query, krRows = null) {
        if (!enabled || !amqDropdownEnabled || !isAnswerInputActive() || !query.trim()) return hidePopup(true);
        const queryKey = searchCacheKey(query);
        if (dismissedQuery && queryKey === dismissedQuery) return hidePopup();
        if (!krRows) {
            if (queryKey !== lastKrQuery) {
                lastKrQuery = queryKey;
                lastKrMatches = search(query);
            }
            krRows = lastKrMatches;
        }
        const lists = getNativeLists();
        const list = lists[0];
        if (!list) return;
        observeNativeLists(lists);
        const resume = pauseNativeObservers(lists);
        try {
            const koreanQuery = hasHangul(query);
            for (const native of lists) {
                if (native.classList.contains('krh-korean-query') !== koreanQuery) native.classList.toggle('krh-korean-query', koreanQuery);
            }
            // Hide every native element before de-duplication. A theme may override
            // the Korean-query stylesheet, and duplicate labels still need hiding.
            syncNativeCandidateVisibility(lists, query);
            const native = nativeCandidates(lists);
            const seen = new Set();
            const krCandidates = [];
            for (const row of krRows) {
                const target = preferredAnswer(row);
                const key = JSON.stringify([row.pKorean, canonicalPunctuationText(target)]);
                if (!target || seen.has(key)) continue;
                seen.add(key);
                krCandidates.push({ type: 'kr', label: row.korean, target, row });
            }
            const next = koreanQuery ? krCandidates : native.filter(candidate => candidate.nativeElement.style.display !== 'none').concat(krCandidates);
            const unchanged = renderedList === list && next.length === matches.length && next.every((candidate, index) => {
                const previous = matches[index];
                return candidate.type === previous.type && candidate.label === previous.label && candidate.target === previous.target &&
                    (candidate.type === 'kr' ? candidate.row === previous.row && previous.nativeElement?.parentElement === list
                        : candidate.nativeElement === previous.nativeElement);
            });
            clearNativeSelection(lists);
            if (!unchanged) {
                const selected = selectionActivated ? matches[selectedIndex] : null;
                const reusable = new Map(matches.filter(candidate => candidate.type === 'kr')
                    .map(candidate => [JSON.stringify([candidate.row.id, candidate.label, candidate.target]), candidate.nativeElement]));
                const wantedElements = new Set();
                for (const candidate of krCandidates) {
                    const key = JSON.stringify([candidate.row.id, candidate.label, candidate.target]);
                    let item = reusable.get(key);
                    if (!item) {
                        item = document.createElement('li');
                        item.dataset.krh = 'true';
                        item.setAttribute('role', 'option');
                        item.setAttribute('aria-selected', 'false');
                        item.textContent = candidate.label;
                        item.title = candidate.target;
                        item.addEventListener('mousedown', event => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.stopImmediatePropagation();
                        }, true);
                        item.addEventListener('click', event => {
                            if (event.button !== 0) return;
                            event.preventDefault();
                            event.stopImmediatePropagation();
                            submitValue(candidate.target);
                        }, true);
                    }
                    candidate.nativeElement = item;
                    wantedElements.add(item);
                }
                for (const native of lists) {
                    for (const item of native.querySelectorAll('li[data-krh="true"]')) {
                        if (native !== list || !wantedElements.has(item)) item.remove();
                    }
                }
                // Reuse matching nodes even when AMQ detached them. Keep list scroll,
                // hover and selection intact instead of replacing every KR item.
                let anchor = Array.from(list.children).filter(item => item.dataset.krh !== 'true').pop() || null;
                for (const candidate of krCandidates) {
                    const item = candidate.nativeElement;
                    const nextNode = anchor ? anchor.nextSibling : list.firstChild;
                    if (nextNode !== item) list.insertBefore(item, nextNode);
                    anchor = item;
                }
                matches = next;
                renderedList = list;
                selectedIndex = selected ? matches.findIndex(candidate => candidate.type === selected.type && candidate.label === selected.label && candidate.target === selected.target) : -1;
                if (selectedIndex < 0) selectionActivated = false;
            }
            lastRenderedQuery = query;
            setListVisible(list, matches.length > 0);
            if (matches.length) updateKeyboardSelection(list);
        } finally { resume(); }
    }

    function dispatchNativeInput(input) {
        dispatchingInput = true;
        try {
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        } finally { dispatchingInput = false; }
    }

    function submitValue(value) {
        const input = answerInput;
        if (!enabled || !isAnswerInputActive() || !value || composing) return;
        const now = Date.now();
        if (lastSubmit.value === value && now - lastSubmit.at < 250) return;
        lastSubmit = { value, at: now };
        const serial = ++submitSerial;
        hidePopup();
        input.value = value;
        dispatchNativeInput(input);
        hidePopup(true);
        dismissedQuery = searchCacheKey(value);
        renderSerial += 1;
        setTimeout(() => {
            // A new question/input or a new user edit must cancel this delayed Enter.
            if (serial !== submitSerial || input !== answerInput || input.value !== value || !enabled || composing || !isAnswerInputActive()) return;
            hidePopup(true);
            bypassNextEnter = true;
            try {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
                input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            } finally { bypassNextEnter = false; }
            hidePopup(true);
        }, 20);
    }

    function choose(index) {
        const candidate = matches[index];
        if (!candidate) return;
        submitValue(candidate.target);
    }

    function queueRender(resetSelection = true) {
        if (!enabled || !amqDropdownEnabled || !isAnswerInputActive()) return hidePopup(true);
        if (resetSelection) { selectedIndex = -1; selectionActivated = false; }
        if (!answerInput.value.trim()) {
            renderSerial += 1;
            if (renderFrame) cancelAnimationFrame(renderFrame);
            renderFrame = 0;
            return hidePopup(true);
        }
        // Reuse the pending frame instead of continually cancelling it. A late
        // native update must not postpone the helper dropdown indefinitely.
        if (renderFrame) return;
        const serial = renderSerial;
        renderFrame = requestAnimationFrame(() => {
            renderFrame = 0;
            if (serial !== renderSerial || !answerInput) return;
            renderPopup(answerInput.value);
        });
    }

    function onInput(event) {
        // dispatchNativeInput is part of our own conversion; user edits invalidate it.
        if (!dispatchingInput) {
            submitSerial += 1;
            if (typeof event?.isComposing === 'boolean') composing = event.isComposing;
        }
        if (!enabled || !amqDropdownEnabled) return hidePopup();
        dismissedQuery = '';
        dropdownWanted = true;
        queueRender();
    }

    function onCompositionStart() {
        composing = true;
        submitSerial += 1;
    }

    function applyPendingCompositionArrow() {
        if (!pendingCompositionArrow || !enabled || !amqDropdownEnabled || !answerInput?.value) return;
        const direction = pendingCompositionArrow;
        pendingCompositionArrow = 0;
        dropdownWanted = true;
        renderPopup(answerInput.value);
        const list = getNativeList();
        if (!list || list.hidden || !matches.length) return;
        selectedIndex = direction > 0 ? 0 : matches.length - 1;
        selectionActivated = true;
        updateKeyboardSelection(list);
    }

    function onCompositionEnd() {
        composing = false;
        dropdownWanted = enabled && amqDropdownEnabled;
        if (!enabled || !amqDropdownEnabled) return;
        queueRender();
        // IME가 첫 방향키를 글자 확정에 사용했다면 확정 직후 동일 방향 선택으로 이어간다.
        queueMicrotask(applyPendingCompositionArrow);
    }

    function onKeyUp(event) {
        if (!pendingCompositionArrow || event.isComposing) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') queueMicrotask(applyPendingCompositionArrow);
    }

    function onKeyDown(event) {
        if (bypassNextEnter && event.key === 'Enter' && !event.isTrusted) return;
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) return;
        if (!enabled || !isAnswerInputActive()) return;
        if (event.key === 'Enter' && (composing || event.isComposing || event.keyCode === 229)) return;
        if ((event.key === 'Enter' || event.key.startsWith('Arrow')) && (event.ctrlKey || event.altKey || event.metaKey)) return;
        if ((composing || event.isComposing) && hasHangul(answerInput?.value || '') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            pendingCompositionArrow = event.key === 'ArrowDown' ? 1 : -1;
            return; // IME의 글자 확정은 막지 않고, compositionend 직후 선택을 적용한다.
        }
        if (!amqDropdownEnabled && hasHangul(answerInput?.value || '')) return;
        if (!event.isComposing && !composing && ['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key) && lastRenderedQuery !== answerInput.value) {
            renderPopup(answerInput.value);
        }
        let nativeList = getNativeList();
        let visible = !!nativeList && !nativeList.hidden && matches.length > 0;
        if (!visible && !event.isComposing && hasHangul(answerInput?.value || '') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            // 느린 환경에서는 첫 방향키가 목록 열기에만 소비되지 않도록 KR 후보를 즉시 확정한다.
            dismissedQuery = '';
            dropdownWanted = true;
            renderPopup(answerInput.value);
            nativeList = getNativeList();
            visible = !!nativeList && !nativeList.hidden && matches.length > 0;
        }
        if (visible && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!selectionActivated) {
                selectedIndex = event.key === 'ArrowDown' ? 0 : matches.length - 1;
                selectionActivated = true;
            }
            else if (selectedIndex < 0) selectedIndex = event.key === 'ArrowDown' ? 0 : matches.length - 1;
            else selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
            // 방향키 이동 중에는 KR 항목 DOM을 재생성하지 않고 선택 상태만 바꾼다.
            updateKeyboardSelection(nativeList);
            return;
        }
        if (visible && event.key === 'Enter' && selectedIndex >= 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
            return choose(selectedIndex);
        }
        if (visible && event.key === 'Escape') {
            // KR Helper/통합 자동완성만 닫고 Escape 이벤트 자체는 막지 않는다.
            // 따라서 AMQ의 "다른 플레이어 답 보기" 같은 원래 ESC 동작은 그대로 실행된다.
            dismissedQuery = searchCacheKey(answerInput.value);
            renderSerial += 1;
            pendingCompositionArrow = 0;
            hidePopup(true);
            return;
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
        const candidates = [];
        const seen = new Set();
        for (const selector of ANSWER_SELECTORS) {
            for (const element of document.querySelectorAll(selector)) {
                if (element instanceof HTMLInputElement && !seen.has(element)) {
                    seen.add(element);
                    candidates.push(element);
                }
            }
        }
        const focused = document.activeElement;
        if (seen.has(focused) && isAnswerInputActive(focused)) return focused;
        return candidates.find(input => isAnswerInputActive(input)) ||
            (answerInput?.isConnected && seen.has(answerInput) ? answerInput : candidates[0]) || null;
    }

    function onAnswerFocus() {
        composing = false;
        pendingCompositionArrow = 0;
        if (enabled && amqDropdownEnabled && answerInput?.value) {
            dropdownWanted = true;
            queueRender(false);
        }
    }

    function onAnswerBlur() {
        composing = false;
        pendingCompositionArrow = 0;
        submitSerial += 1;
        renderSerial += 1;
        if (renderFrame) cancelAnimationFrame(renderFrame);
        renderFrame = 0;
        hidePopup(true);
    }

    function observeAnswerInputState() {
        answerStateObserver?.disconnect();
        if (!answerInput) return;
        answerStateObserver = new MutationObserver(() => {
            if (!isAnswerInputActive()) {
                composing = false;
                pendingCompositionArrow = 0;
                submitSerial += 1;
                hidePopup(true);
            } else if (dropdownWanted && document.activeElement === answerInput && answerInput.value.trim()) queueRender(false);
        });
        const targets = new Set([
            answerInput,
            answerInput.closest('.awesomplete'),
            answerInput.closest('#qpAnswerInputContainer'),
            answerInput.parentElement
        ].filter(Boolean));
        let ancestor = answerInput.parentElement;
        for (let depth = 0; ancestor && ancestor !== document.body && depth < 6; depth += 1) {
            targets.add(ancestor);
            ancestor = ancestor.parentElement;
        }
        targets.forEach(target => answerStateObserver.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'disabled', 'readonly']
        }));
    }

    function bindInput() {
        const next = findAnswerInput();
        if (next === answerInput) { observeNativeLists(); return; }
        if (answerInput) {
            hidePopup();
            answerInput.removeEventListener('input', onInput);
            answerInput.removeEventListener('keydown', onKeyDown, true);
            answerInput.removeEventListener('keyup', onKeyUp, true);
            answerInput.removeEventListener('focus', onAnswerFocus);
            answerInput.removeEventListener('blur', onAnswerBlur);
            answerInput.removeEventListener('compositionstart', onCompositionStart);
            answerInput.removeEventListener('compositionend', onCompositionEnd);
            answerInput.closest('.awesomplete')?.classList.remove('krh-answer-wrapper');
        }
        submitSerial += 1;
        renderSerial += 1;
        composing = false;
        pendingCompositionArrow = 0;
        answerInput = next;
        const wrapper = answerInput?.closest('.awesomplete');
        if (wrapper && !wrapper.classList.contains('krh-answer-wrapper')) wrapper.classList.add('krh-answer-wrapper');
        observeAnswerInputState();
        observeNativeLists();
        if (!answerInput) return;
        answerInput.addEventListener('input', onInput);
        answerInput.addEventListener('keydown', onKeyDown, true);
        answerInput.addEventListener('keyup', onKeyUp, true);
        answerInput.addEventListener('focus', onAnswerFocus);
        answerInput.addEventListener('blur', onAnswerBlur);
        answerInput.addEventListener('compositionstart', onCompositionStart);
        answerInput.addEventListener('compositionend', onCompositionEnd);
    }

    function restoreMultipleChoice(elements = document.querySelectorAll(MULTIPLE_CHOICE_SELECTOR)) {
        multipleChoiceObserver?.disconnect();
        try {
            elements.forEach(element => {
                    if (element.dataset.krhApplied !== 'true') return;
                    if (element.textContent.trim() === element.dataset.krhKorean) {
                        element.textContent = element.dataset.krhOriginalText || element.textContent;
                        element.style.fontSize = element.dataset.krhOriginalFontSize || '';
                        element.title = element.dataset.krhOriginalTitle || '';
                    }
                    // 내용이 이미 달라졌다면 AMQ가 새 문제의 문구와 크기를 적용한 상태이므로 건드리지 않는다.
                    delete element.dataset.krhApplied;
                    delete element.dataset.krhKorean;
                    delete element.dataset.krhOriginalText;
                    delete element.dataset.krhOriginalFontSize;
                    delete element.dataset.krhOriginalTitle;
            });
        } finally { observeMultipleChoiceContainer(); }
    }

    function isMultipleChoiceVisible(container) {
        if (!container?.isConnected) return false;
        const style = getComputedStyle(container);
        const rect = container.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && !container.hidden && rect.width > 0 && rect.height > 0;
    }

    function replaceMultipleChoice() {
        multipleChoiceObserver?.disconnect();
        try {
            const container = document.getElementById('qpMultipleChoiceContainer');
            const elements = container?.querySelectorAll('.qpMultipleChoiceEntryText') || [];
            if (!enabled || !isMultipleChoiceVisible(container)) {
                restoreMultipleChoice(elements);
                return;
            }
            if (!rows.length) return;
            elements.forEach(element => {
                if (element.dataset.krhApplied === 'true') {
                    if (element.textContent.trim() === element.dataset.krhKorean) return;
                    // AMQ가 같은 요소를 다음 문제의 새 선택지로 재사용한 경우 이전 표시를 폐기한다.
                    // 이 시점의 글자 크기와 툴팁은 새 선택지에 맞춰 AMQ가 계산한 값이므로 유지한다.
                    delete element.dataset.krhApplied;
                    delete element.dataset.krhKorean;
                    delete element.dataset.krhOriginalText;
                    delete element.dataset.krhOriginalFontSize;
                    delete element.dataset.krhOriginalTitle;
                }
                const original = element.textContent.trim();
                const candidates = choiceIndex.get(canonicalPunctuationText(original));
                const korean = candidates?.size === 1 ? candidates.values().next().value.korean : '';
                if (!korean) return;
                element.dataset.krhOriginalText = original;
                element.dataset.krhOriginalFontSize = element.style.fontSize || '';
                element.dataset.krhOriginalTitle = element.title || '';
                element.dataset.krhKorean = korean;
                element.dataset.krhApplied = 'true';
                element.textContent = korean;
                element.title = original;
                element.style.fontSize = korean.length <= 12 ? '18px' : korean.length <= 20 ? '14px' : korean.length <= 28 ? '12px' : '10px';
            });
        } finally { observeMultipleChoiceContainer(); }
    }

    function observeMultipleChoiceContainer() {
        if (multipleChoiceObserver && observedMultipleChoiceContainer?.isConnected) {
            multipleChoiceObserver.observe(observedMultipleChoiceContainer, {
                childList: true, subtree: true, characterData: true,
                attributes: true, attributeFilter: ['class', 'style', 'hidden']
            });
        }
    }

    function ensureMultipleChoiceObserver() {
        const container = document.getElementById('qpMultipleChoiceContainer');
        if (container === observedMultipleChoiceContainer) return;
        multipleChoiceObserver?.disconnect();
        clearTimeout(multipleChoiceTimer);
        observedMultipleChoiceContainer = container;
        if (!container) return;
        multipleChoiceObserver = new MutationObserver(() => {
            clearTimeout(multipleChoiceTimer);
            multipleChoiceTimer = setTimeout(replaceMultipleChoice, 35);
        });
        observeMultipleChoiceContainer();
        replaceMultipleChoice();
    }

    function parseCsv(text) {
        // Detect the separator in the first record, outside quoted cells.
        let delimiter = ',', inQuotes = false;
        for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (ch === '"') {
                if (inQuotes && text[i + 1] === '"') i += 1;
                else inQuotes = !inQuotes;
            } else if (!inQuotes && ch === '\t') { delimiter = '\t'; break; }
            else if (!inQuotes && (ch === '\n' || ch === '\r')) break;
        }
        const table = [];
        let row = [], cell = '', quoted = false;
        for (let i = 0; i < text.length; i += 1) {
            const ch = text[i];
            if (quoted && ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; }
            else if (ch === '"' && (quoted || !cell)) quoted = !quoted;
            else if (ch === delimiter && !quoted) { row.push(cell); cell = ''; }
            else if ((ch === '\n' || ch === '\r') && !quoted) {
                if (ch === '\r' && text[i + 1] === '\n') i += 1;
                row.push(cell); cell = '';
                if (row.some(value => value.trim())) table.push(row);
                row = [];
            } else cell += ch;
        }
        if (quoted) throw new Error('시트 데이터의 따옴표가 닫히지 않았습니다.');
        row.push(cell);
        if (row.some(value => value.trim())) table.push(row);
        if (!table.length) throw new Error('시트 데이터가 비어 있습니다.');
        const headers = table.shift().map(value => value.replace(/^\uFEFF/, '').trim());
        const keys = headers.map(header => header.toLowerCase().replace(/[^a-z가-힣]/g, ''));
        const hasKorean = ['koreananswer', 'korean', '한글'].some(key => keys.includes(key));
        const hasTarget = ['englishanswer', 'englishansawer', 'english', '영어', 'romajianswer', 'romaji', 'romanji', '로마자'].some(key => keys.includes(key));
        if (!hasKorean || !hasTarget) throw new Error('한글/영어/로마자 헤더를 찾지 못했습니다. 시트 URL과 공유 설정을 확인하세요.');
        return table.map(values => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
    }

    function requestText(url) {
        const cacheBusted = `${url}${url.includes('?') ? '&' : '?'}_krh=${Date.now()}`;
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => GM_xmlhttpRequest({
                method: 'GET', url: cacheBusted, timeout: REQUEST_TIMEOUT_MS,
                headers: { 'Cache-Control': 'no-cache' },
                onload: response => response.status >= 200 && response.status < 300 ? resolve(response.responseText) : reject(new Error(`HTTP ${response.status}`)),
                onerror: () => reject(new Error('시트 네트워크 오류')),
                ontimeout: () => reject(new Error('시트 요청 시간 초과')),
                onabort: () => reject(new Error('시트 요청 취소'))
            }));
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        return fetch(cacheBusted, { cache: 'no-store', signal: controller.signal })
            .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
            .finally(() => clearTimeout(timer));
    }

    function normalizeSheetUrl(url) {
        const value = String(url || '').trim();
        if (!value) return '';
        if (/\/export\?/i.test(value) || /[?&]output=(csv|tsv)/i.test(value)) return value;
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
            const payload = await requestText(url);
            // Do not apply a response for an old URL after the settings have changed.
            if (url !== normalizeSheetUrl(loadValue(STORAGE.sheetUrl, DEFAULT_SHEET_URL))) return;
            if (url === lastSheetUrl && payload === lastSheetText) return;
            const parsed = parseCsv(payload);
            const prepared = prepareRows(parsed);
            if (parsed.length && !prepared.length) throw new Error('사용 가능한 답변 행이 없습니다. 기존 캐시를 유지합니다.');
            restoreMultipleChoice();
            hydrate(parsed, prepared);
            lastSheetText = payload;
            lastSheetUrl = url;
            saveValue(STORAGE.rows, parsed);
            replaceMultipleChoice();
            if (answerInput?.value) queueRender(false);
        } catch (error) { console.warn('[AMQ KR Helper] 시트 갱신 실패, 캐시 유지:', error); }
        finally {
            refreshBusy = false;
            if (url !== normalizeSheetUrl(loadValue(STORAGE.sheetUrl, DEFAULT_SHEET_URL))) queueMicrotask(refreshSheet);
        }
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
            enabled = !enabled;
            saveValue(STORAGE.enabled, enabled);
            if (!enabled) hidePopup(); else refreshSheet();
            replaceMultipleChoice();
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
            replaceMultipleChoice();
        });
        label.append(checkbox, document.createTextNode('KR Helper'));
        container.parentElement.insertBefore(label, container);
    }

    function start() {
        ensureStyle();
        restoreRows();
        // Dropdown command notices are inspected only as they arrive.
        configureMenu();
        bindInput();
        ensureToggle();
        ensureMultipleChoiceObserver();
        refreshSheet();
        if (!refreshTimer) refreshTimer = setInterval(refreshSheet, REFRESH_MS);
        // Small fallback for state changes on ancestors and game UI replacements.
        if (!watchTimer) watchTimer = setInterval(() => {
            ensureToggle();
            bindInput();
            ensureMultipleChoiceObserver();
            replaceMultipleChoice();
            if (!isAnswerInputActive() || !answerInput?.value.trim()) hidePopup(true);
            else if (dropdownWanted && enabled && amqDropdownEnabled && document.activeElement === answerInput && hasHangul(answerInput.value) &&
                !dismissedQuery && (!getNativeList()?.querySelector('li[data-krh="true"]') || getNativeList()?.hidden)) queueRender(false);
        }, 1000);
        if (!observer) {
            let scheduled = false;
            const structureSelector = '#qpAnswerInput, input.qpAnswerInput, .qpAnswerInput, .awesomplete, ul[role="listbox"], #qpMultipleChoiceContainer, #menuBarOptionContainer';
            observer = new MutationObserver(mutations => {
                let structureChanged = false;
                for (const mutation of mutations) {
                    const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
                    // Our own candidate/choice writes do not require rebinding the page.
                    if (target?.closest(`ul[role="listbox"], #${POPUP_ID}, #qpMultipleChoiceContainer`)) continue;
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1 && node.matches('script, style')) continue;
                        detectDropdownCommandState(node);
                    }
                    for (const node of [...mutation.addedNodes, ...mutation.removedNodes]) {
                        if (!(node instanceof Element)) continue;
                        if (node.matches(structureSelector) || node.querySelector(structureSelector) ||
                            (answerInput && node.contains(answerInput))) structureChanged = true;
                    }
                }
                if (!structureChanged || scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => {
                    scheduled = false;
                    bindInput();
                    ensureToggle();
                    ensureMultipleChoiceObserver();
                    if (!isAnswerInputActive() || !answerInput?.value.trim()) hidePopup(true);
                    else queueRender(false);
                });
            });
            observer.observe(document.body, { childList: true, subtree: true });
        }
        document.addEventListener('focusin', event => {
            if (event.target instanceof HTMLInputElement && event.target !== answerInput) bindInput();
        });
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
