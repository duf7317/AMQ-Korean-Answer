// ==UserScript==
// @name         AMQ KR Helper
// @namespace    amq-kr-helper
// @version      1.10.14
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

    const VERSION = '1.10.14';
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
    const MULTIPLE_CHOICE_SELECTOR = '#qpMultipleChoiceContainer .qpMultipleChoiceEntryText';

    let rows = [];
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
    let lastRenderSignature = '';
    let amqDropdownEnabled = sessionStorage.getItem('amqKrHelperNativeDropdownEnabled') !== 'false';
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

    // 검색어에 -, +, ~가 들어간 경우 이 문자는 AMQ 검색 명령으로 해석하지 않고
    // KoreanAnswer 열에 실제로 존재하는 문자 그대로 검색한다.
    // 예: -hen -> Megami-hen 매칭, -gl -> GLORY LINE 불일치.
    function literalSearchText(value) {
        return String(value || '')
            .normalize('NFKC')
            .toLocaleLowerCase()
            .replace(/[‐‑‒–—―]/g, '-')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function usesLiteralSpecialSearch(value) {
        return /[-+~]/.test(String(value || ''));
    }

    function searchCacheKey(value) {
        return usesLiteralSpecialSearch(value)
            ? `literal:${literalSearchText(value)}`
            : `normal:${normalize(value)}`;
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
        const korean = String(rowValue(raw, ['KoreanAnswer', 'Korean', '한글'])).trim();
        const english = String(rowValue(raw, ['EnglishAnswer', 'EnglishAnsawer', 'English', '영어'])).trim();
        const romaji = String(rowValue(raw, ['RomajiAnswer', 'Romaji', 'Romanji', '로마자'])).trim();
        if (!korean || (!english && !romaji)) return null;
        const item = { id: index, korean, english, romaji };
        item.nKorean = normalize(korean);
        item.lKorean = literalSearchText(korean);
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
        const { nq, cq, qTokens, literalQuery } = context;
        if (!nq || !cq) return null;

        // -, +, ~가 검색어에 포함되면 해당 문자를 삭제/공백화하지 않고
        // KoreanAnswer 실제 문자열에서 그대로 포함되는지 검사한다.
        if (literalQuery) {
            const haystack = row.lKorean || literalSearchText(row.korean);
            if (!haystack.includes(literalQuery)) return null;
            const exact = haystack === literalQuery;
            const tier = haystack.startsWith(literalQuery) ? 0 : 1;
            return {
                row,
                tier,
                exact: exact ? 0 : 1,
                length: Math.min(row.korean.length, row.english.length || Infinity, row.romaji.length || Infinity)
            };
        }

        // 일반 검색은 기존 v1.10.13 동작을 그대로 유지한다.
        // KR 후보는 KoreanAnswer 열의 실제 문자열만 검색한다.
        const allTokens = qTokens.every(token => row.nKorean.includes(token) || row.cKorean.includes(token.replace(/\s/g, '')));
        const compactIncluded = row.cKorean.includes(cq);
        if (!allTokens && !compactIncluded) return null;
        let tier = 2;
        if (row.nKorean.startsWith(nq) || row.cKorean.startsWith(cq)) tier = 0;
        else if (allTokens) tier = 1;
        const exact = row.nKorean === nq || row.cKorean === cq;
        return { row, tier, exact: exact ? 0 : 1, length: Math.min(row.korean.length, row.english.length || Infinity, row.romaji.length || Infinity) };
    }

    function search(query) {
        const nq = normalize(query);
        const literalQuery = usesLiteralSpecialSearch(query) ? literalSearchText(query) : '';
        const context = {
            nq,
            cq: nq.replace(/\s/g, ''),
            qTokens: nq.split(' ').filter(Boolean),
            literalQuery
        };
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
            .awesomplete ul[role="listbox"].krh-korean-query > li:not([data-krh="true"]),
            ul[role="listbox"].krh-korean-query > li:not([data-krh="true"]){display:none!important}
            #qpMultipleChoiceContainer .qpMultipleChoiceEntryTextContainer .qpMultipleChoiceEntryText{overflow:visible!important;white-space:normal!important;word-break:keep-all!important;line-height:1.15!important}
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

    function isAnswerInputActive() {
        if (!answerInput?.isConnected || answerInput.disabled || answerInput.readOnly) return false;
        if (!answerInput.getClientRects().length) return false;
        const style = getComputedStyle(answerInput);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const container = answerInput.closest('#qpAnswerInput, #qpAnswerInputContainer, .qpAnswerInput');
        if (container && !container.getClientRects().length) return false;
        return true;
    }

    function hidePopup(closeNative = false) {
        if (popup) popup.style.display = 'none';
        getNativeLists().forEach(native => {
            native.classList.remove('krh-korean-query');
            native.querySelectorAll('li[data-krh="true"]').forEach(item => item.remove());
            native.querySelectorAll('li[data-krh-native-hidden="true"]').forEach(item => {
                item.style.removeProperty('display');
                delete item.dataset.krhNativeHidden;
            });
            if (closeNative) {
                if (!native.hidden) native.hidden = true;
            }
        });
        matches = [];
        selectedIndex = -1;
        selectionActivated = false;
        lastRenderSignature = '';
    }

    function setAmqDropdownEnabled(value) {
        if (amqDropdownEnabled === value) return;
        amqDropdownEnabled = value;
        sessionStorage.setItem('amqKrHelperNativeDropdownEnabled', value ? 'true' : 'false');
        if (!value) hidePopup();
        else if (enabled && answerInput?.value) queueRender();
        console.info(`[AMQ KR Helper] AMQ dropdown ${value ? 'enabled' : 'disabled'}`);
    }

    function detectDropdownCommandState(node) {
        const text = String(node?.textContent || '');
        if (!text) return;
        const disabledAt = text.toLowerCase().lastIndexOf('dropdown disabled');
        const enabledAt = text.toLowerCase().lastIndexOf('dropdown enabled');
        if (disabledAt < 0 && enabledAt < 0) return;
        setAmqDropdownEnabled(enabledAt > disabledAt);
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
        const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
        return changedNodes.some(node => {
            if (!(node instanceof Element)) return String(node.textContent || '').trim().length > 0;
            if (node.matches('li[data-krh="true"]') || node.closest('li[data-krh="true"]')) return false;
            return node.matches('li') || !!node.querySelector('li:not([data-krh="true"])');
        });
    }

    function observeNativeLists() {
        getNativeLists().forEach(list => {
            if (nativeListObservers.has(list)) return;
            const listObserver = new MutationObserver(mutations => {
                if (!mutations.some(mutationContainsNativeCandidate)) return;
                if (!enabled || !amqDropdownEnabled || !answerInput?.value) return;
                const query = answerInput.value;
                const cachedKr = searchCacheKey(query) === lastKrQuery ? lastKrMatches : [];
                // AMQ가 영어/Romaji 후보를 만든 바로 그 시점에 통합 목록을 갱신한다.
                queueMicrotask(() => {
                    if (answerInput?.value === query) renderPopup(query, cachedKr, true);
                });
            });
            listObserver.observe(list, { childList: true, subtree: true });
            nativeListObservers.set(list, listObserver);
        });
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
            candidate.nativeElement?.setAttribute('aria-selected', selectedIndex === index ? 'true' : 'false');
        });
        if (selectedIndex >= 0) scrollSelectionIntoView(list, matches[selectedIndex]?.nativeElement);
    }

    function renderPopup(query, krRows = null, force = false) {
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
        observeNativeLists();
        lists.forEach(native => native.querySelectorAll('li[data-krh="true"]').forEach(item => item.remove()));

        const koreanQuery = hasHangul(query);
        lists.forEach(nativeList => nativeList.classList.toggle('krh-korean-query', koreanQuery));
        const native = nativeCandidates();
        native.forEach(candidate => {
            if (koreanQuery) {
                // AMQ가 직전 영문 검색에서 남긴 후보는 한글 검색 목록에서 완전히 제거한다.
                // 다음 영문 입력 시 Awesomplete가 현재 검색어로 후보 DOM을 다시 생성한다.
                candidate.nativeElement.remove();
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
        if (!matches.length) {
            list.hidden = true;
            return;
        }
        if (selectedIndex >= matches.length) selectedIndex = -1;
        matches.forEach((candidate, index) => candidate.nativeElement?.setAttribute('aria-selected', selectedIndex === index ? 'true' : 'false'));
        list.hidden = false;
        list.removeAttribute('hidden');
        if (selectedIndex >= 0) scrollSelectionIntoView(list, matches[selectedIndex]?.nativeElement);
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
        // 변환된 영문 값을 넣는 input 이벤트가 AMQ 자동완성을 다시 열 수 있으므로
        // 이 제출값은 새 사용자 입력이 생길 때까지 닫힌 상태로 기억한다.
        dismissedQuery = searchCacheKey(value);
        renderSerial += 1;
        bypassNextEnter = true;
        setTimeout(() => {
            answerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            answerInput.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
            hidePopup(true);
            requestAnimationFrame(() => hidePopup(true));
        }, 20);
    }

    function choose(index) {
        const candidate = matches[index];
        if (!candidate) return;
        submitValue(candidate.target);
    }

    function queueRender() {
        const serial = ++renderSerial;
        if (!isAnswerInputActive()) return hidePopup(true);
        const query = answerInput?.value || '';
        // 입력을 모두 지우면 이전 문제의 AMQ 후보가 다시 노출되지 않도록 목록 전체를 닫는다.
        if (!query.trim()) {
            hidePopup(true);
            requestAnimationFrame(() => {
                if (serial === renderSerial && !answerInput?.value.trim()) hidePopup(true);
            });
            return;
        }
        selectedIndex = -1;
        selectionActivated = false;
        lastKrQuery = searchCacheKey(query);
        lastKrMatches = search(query);
        // 고정 지연 없이 현재 후보를 즉시 표시한다.
        renderPopup(query, lastKrMatches, true);
        if (!hasHangul(query)) {
            requestAnimationFrame(() => {
                if (serial !== renderSerial || answerInput?.value !== query) return;
                // 영문 입력에서만 AMQ가 같은 입력으로 만든 기본 후보를 한 번 더 합친다.
                renderPopup(query, lastKrMatches, true);
            });
        }
    }

    function onInput() {
        if (!enabled || !amqDropdownEnabled) return hidePopup();
        dismissedQuery = '';
        queueRender();
    }

    function applyPendingCompositionArrow() {
        if (!pendingCompositionArrow || !enabled || !amqDropdownEnabled || !answerInput?.value) return;
        const direction = pendingCompositionArrow;
        pendingCompositionArrow = 0;
        renderPopup(answerInput.value, null, true);
        const list = getNativeList();
        if (!list || list.hidden || !matches.length) return;
        selectedIndex = direction > 0 ? 0 : matches.length - 1;
        selectionActivated = true;
        updateKeyboardSelection(list);
    }

    function onCompositionEnd() {
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
        if (bypassNextEnter && event.key === 'Enter') {
            bypassNextEnter = false;
            return;
        }
        if (event.isComposing && hasHangul(answerInput?.value || '') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            pendingCompositionArrow = event.key === 'ArrowDown' ? 1 : -1;
            return; // IME의 글자 확정은 막지 않고, compositionend 직후 선택을 적용한다.
        }
        if (!amqDropdownEnabled && hasHangul(answerInput?.value || '')) return;
        let nativeList = getNativeList();
        let visible = !!nativeList && !nativeList.hidden && matches.length > 0;
        if (!visible && !event.isComposing && hasHangul(answerInput?.value || '') && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            // 느린 환경에서는 첫 방향키가 목록 열기에만 소비되지 않도록 KR 후보를 즉시 확정한다.
            dismissedQuery = '';
            renderPopup(answerInput.value, null, true);
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
        for (const selector of ANSWER_SELECTORS) {
            const element = document.querySelector(selector);
            if (element instanceof HTMLInputElement) return element;
        }
        return null;
    }

    function observeAnswerInputState() {
        answerStateObserver?.disconnect();
        if (!answerInput) return;
        answerStateObserver = new MutationObserver(() => {
            if (!isAnswerInputActive()) hidePopup(true);
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
        if (!next) return;
        if (next === answerInput) {
            observeNativeLists();
            return;
        }
        if (answerInput) {
            answerInput.removeEventListener('input', onInput);
            answerInput.removeEventListener('keydown', onKeyDown, true);
            answerInput.removeEventListener('keyup', onKeyUp, true);
            answerInput.removeEventListener('compositionend', onCompositionEnd);
            answerInput.closest('.awesomplete')?.classList.remove('krh-answer-wrapper');
        }
        answerInput = next;
        answerInput.closest('.awesomplete')?.classList.add('krh-answer-wrapper');
        answerInput.addEventListener('input', onInput);
        answerInput.addEventListener('keydown', onKeyDown, true);
        answerInput.addEventListener('keyup', onKeyUp, true);
        answerInput.addEventListener('compositionend', onCompositionEnd);
        observeAnswerInputState();
        observeNativeLists();
    }

    function restoreMultipleChoice(elements = document.querySelectorAll(MULTIPLE_CHOICE_SELECTOR)) {
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
    }

    function isMultipleChoiceVisible(container) {
        if (!container?.isConnected) return false;
        const style = getComputedStyle(container);
        const rect = container.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && !container.hidden && rect.width > 0 && rect.height > 0;
    }

    function replaceMultipleChoice() {
        const container = document.getElementById('qpMultipleChoiceContainer');
        const elements = container?.querySelectorAll('.qpMultipleChoiceEntryText') || [];
        if (!enabled || !isMultipleChoiceVisible(container)) {
            restoreMultipleChoice(elements);
            return;
        }
        if (!rows.length) return;
        const byAnswer = new Map();
        rows.forEach(row => {
            [row.english, row.romaji].filter(Boolean).forEach(name => {
                const key = compact(name);
                // 같은 정답의 쉼표 별칭은 시트에 적힌 첫 번째 이름을 대표명으로 유지한다.
                if (!byAnswer.has(key)) byAnswer.set(key, row.korean);
            });
        });
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
            const korean = byAnswer.get(compact(original));
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
    }

    function ensureMultipleChoiceObserver() {
        const container = document.getElementById('qpMultipleChoiceContainer');
        if (!container || container === observedMultipleChoiceContainer) return;
        multipleChoiceObserver?.disconnect();
        observedMultipleChoiceContainer = container;
        multipleChoiceObserver = new MutationObserver(() => {
            clearTimeout(multipleChoiceTimer);
            // 숨겨지는 순간에는 원문을 즉시 복구해 AMQ의 다음 선택지 갱신을 방해하지 않는다.
            if (!isMultipleChoiceVisible(container)) {
                restoreMultipleChoice(container.querySelectorAll('.qpMultipleChoiceEntryText'));
                return;
            }
            // AMQ가 네 선택지를 모두 채운 뒤 한 번만 번역한다.
            multipleChoiceTimer = setTimeout(replaceMultipleChoice, 35);
        });
        multipleChoiceObserver.observe(container, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden']
        });
        replaceMultipleChoice();
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
        restoreRows();
        detectDropdownCommandState(document.body);
        configureMenu();
        bindInput();
        replaceMultipleChoice();
        refreshSheet();
        if (!refreshTimer) refreshTimer = setInterval(refreshSheet, REFRESH_MS);
        ensureMultipleChoiceObserver();
        if (!watchTimer) watchTimer = setInterval(() => { ensureToggle(); bindInput(); ensureMultipleChoiceObserver(); replaceMultipleChoice(); }, 1000);
        if (!observer) {
            let scheduled = false;
            observer = new MutationObserver(mutations => {
                mutations.forEach(mutation => mutation.addedNodes.forEach(detectDropdownCommandState));
                if (scheduled) return;
                scheduled = true;
                requestAnimationFrame(() => {
                    scheduled = false;
                    bindInput();
                    if (!isAnswerInputActive() || !answerInput.value.trim()) hidePopup(true);
                    ensureMultipleChoiceObserver();
                    replaceMultipleChoice();
                });
            });
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
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
