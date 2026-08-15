// ==UserScript==
// @name         AMQ KR Helper (DOM inject, no jQuery)
// @namespace    amq-kr-helper
// @version      1.6
// @description  AMQ 원래 정답창에서 한글/영어 통합 입력 · 한글 자동 변환/후보 · 시트 1분 자동 갱신
// @author       You
// @match        https://animemusicquiz.com/*
// @run-at       document-end
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/duf7317/AMQ-Korean-Answer/main/amq-kr-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/duf7317/AMQ-Korean-Answer/main/amq-kr-helper.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SHEET_URL =
    "https://docs.google.com/spreadsheets/d/19-YDyMy__mPoP5Ozi7nPJ-A83XwsljODhhqmzuv1P2g/export?format=tsv&gid=0";

  const TAG = "[KR Helper]";
  const STORAGE_KEY = "amq-kr-helper-enabled";
  const SHEET_POLL_INTERVAL_MS = 60 * 1000; // 시트 변경 감지 주기 (1분)
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const error = (...a) => console.error(TAG, ...a);

  /** 시트 데이터 캐시 (주기 갱신 시 여기 덮어씀) */
  let cachedData = {
    mapKoToEn: new Map(),
    uniqueKoList: [],
    mapEnToKo: new Map(),
  };
  let lastTsvText = "";
  let answerWatchTimer = null;
  let injectDebounceTimer = null;
  let lastSubmitText = "";
  let lastSubmitAt = 0;

  const mergedBoundInputs = new WeakSet();
  const mergedSuggest = {
    box: null,
    input: null,
    items: [],
    index: -1,
  };

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) !== "false";
  }
  function setEnabled(v) {
    localStorage.setItem(STORAGE_KEY, v ? "true" : "false");
  }

  log("Script loaded at:", location.href);

  /** 객관식 텍스트 박스: 글자가 박스 밖으로 나오지 않도록 넓히고, 높이도 내용만큼 늘어나게 */
  function injectMultipleChoiceBoxStyle() {
    const id = "amq-kr-helper-multiple-choice-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      .qpMultipleChoiceEntryTextContainer .qpMultipleChoiceEntryText {
        overflow: visible !important;
        white-space: normal !important;
        word-break: keep-all !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    log("Multiple choice box style injected");
  }
  injectMultipleChoiceBoxStyle();

  function injectMergedAnswerStyle() {
    const id = "amq-kr-helper-merged-style";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      #krMergedSuggestions {
        position: fixed;
        z-index: 2147483647;
        display: none;
        max-height: 260px;
        overflow-y: auto;
        background: rgba(13, 18, 27, .98);
        border: 1px solid #4b6b99;
        border-radius: 5px;
        box-shadow: 0 8px 24px rgba(0,0,0,.45);
        color: #f2f6ff;
        font-size: 14px;
        text-align: left;
      }
      #krMergedSuggestions .krMergedItem {
        padding: 7px 10px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #krMergedSuggestions .krMergedItem:hover,
      #krMergedSuggestions .krMergedItem.selected {
        background: #245ca6;
        color: #fff;
      }
      #krMergedSuggestions .krMergedItem small {
        display: block;
        color: #aebbd0;
        font-size: 11px;
        margin-top: 2px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  injectMergedAnswerStyle();

  /** AMQ 옵션: 0 = English(B열), 1 = Romaji(C열). options.useRomajiNames */
  function getUseRomaji() {
    try {
      const opts = typeof unsafeWindow !== "undefined" && unsafeWindow.options;
      return opts && opts.useRomajiNames === 1;
    } catch (e) {
      return false;
    }
  }

  async function fetchTSV(url) {
    const sep = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${sep}_krh=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const text = await response.text();
    log("TSV fetched successfully, length:", text.length);
    return text;
  }

  function parseTSV(tsv) {
    const lines = tsv.split(/\r?\n/).filter(Boolean);
    if (lines.length < 1) {
      warn("TSV is empty or invalid");
      return { mapKoToEn: new Map(), uniqueKoList: [], mapEnToKo: new Map() };
    }

    const split = (line) => line.split("\t").map((s) => s.trim());
    const header = split(lines[0]).map((h) => h.toLowerCase());
    const koIdx = header.findIndex((h) => h === "koreananswer");
    const enIdx = header.findIndex((h) => h === "englishanswer" || h === "englishansawer");
    const romajiIdx = header.findIndex((h) => h === "romaji");
    const useThirdAsRomaji = romajiIdx === -1 && header.length > 2;

    const startRow = koIdx !== -1 && enIdx !== -1 ? 1 : 0;
    const realKoIdx = koIdx !== -1 ? koIdx : 0;
    const realEnIdx = enIdx !== -1 ? enIdx : 1;
    const realRomajiIdx = romajiIdx !== -1 ? romajiIdx : (useThirdAsRomaji ? 2 : realEnIdx);

    const mapKoToEn = new Map();
    const mapEnToKo = new Map();
    const koList = [];

    for (let i = startRow; i < lines.length; i++) {
      const cols = split(lines[i]);
      const maxIdx = Math.max(realKoIdx, realEnIdx, realRomajiIdx);
      if (cols.length <= maxIdx) continue;

      const koRaw = (cols[realKoIdx] || "").trim();
      const en = (cols[realEnIdx] || "").trim();
      const romaji = (cols[realRomajiIdx] || "").trim() || en;
      if (!koRaw || (!en && !romaji)) continue;

      const enVal = en || romaji;
      const romajiVal = romaji || en;
      const aliases = koRaw.split(",").map((s) => s.trim()).filter(Boolean);
      for (const ko of aliases) {
        mapKoToEn.set(ko, { en: enVal, romaji: romajiVal });
        koList.push(ko);
        if (!mapEnToKo.has(enVal)) mapEnToKo.set(enVal, []);
        mapEnToKo.get(enVal).push(ko);
        if (romajiVal !== enVal) {
          if (!mapEnToKo.has(romajiVal)) mapEnToKo.set(romajiVal, []);
          mapEnToKo.get(romajiVal).push(ko);
        }
      }
    }

    const unique = [...new Set(koList)];
    log(`Parsed ${mapKoToEn.size} mappings (${unique.length} unique Korean), B/C columns for English/Romaji`);
    return { mapKoToEn, uniqueKoList: unique, mapEnToKo };
  }

  function attachDatalistFallback(krInput, uniqueKoList) {
    const existingId = "krAnswerDatalist";
    let datalist = document.getElementById(existingId);
    if (datalist) datalist.remove();

    datalist = document.createElement("datalist");
    datalist.id = existingId;

    uniqueKoList.forEach((ko) => {
      const opt = document.createElement("option");
      opt.value = ko;
      datalist.appendChild(opt);
    });

    document.body.appendChild(datalist);
    krInput.setAttribute("list", existingId);
    log("Datalist dropdown attached (시트 데이터 적용)");
  }

  function getSelectedDropdownItem(krInput) {
    const ul = document.querySelector(".awesomplete ul[role=listbox]");
    if (!ul) return null;

    const selected =
      ul.querySelector("li[aria-selected='true']") ||
      ul.querySelector("li.awesomplete-selected") ||
      ul.querySelector("li");
    return selected ? selected.textContent.trim() : null;
  }

  function isDropdownVisible() {
    const ul = document.querySelector(".awesomplete ul[role=listbox]");
    if (!ul) return false;
    const r = ul.getBoundingClientRect();
    const s = getComputedStyle(ul);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
  }

  function removeKrHelperFromNonFirstContainers() {
    // v1.6: 별도 한글 입력창을 생성하지 않음.
  }

  function pickTopmostVisibleAnswerInput() {
    const containers = document.querySelectorAll(
      "[id='qpAnswerInputContainer'], .qpAnswerInputContainer"
    );
    if (containers.length > 1) {
      const firstContainer = containers[0];
      const input =
        firstContainer.querySelector("#qpAnswerInput, [id='qpAnswerInput']") ||
        firstContainer.querySelector("input.flatTextInput") ||
        firstContainer.querySelector("input[type='text']") ||
        firstContainer.querySelector("input");
      if (input) {
        const r = input.getBoundingClientRect();
        const s = getComputedStyle(input);
        if (r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden") {
          return input;
        }
        return input;
      }
    }

    const list = Array.from(document.querySelectorAll("#qpAnswerInput"));
    if (list.length === 0) return null;

    const visible = list.filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden";
    });

    const candidates = visible.length ? visible : list;
    candidates.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    return candidates[0];
  }

  function isPopupOpen() {
    const selectors = [
      ".modal.show",
      ".modal.in",
      ".swal2-container",
      "#swal2-container",
      ".iziModal-overlay",
      ".v--modal-overlay",
      ".ui-widget-overlay",
      ".popupContainer",
      ".overlay",
      ".modalOverlay",
    ];

    return selectors.some((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  }

  function setupPopupGuard() {
    if (window.__krHelperPopupGuard) return;
    window.__krHelperPopupGuard = true;

    const apply = () => {
      const helper = document.querySelector("#krMergedSuggestions");
      if (!helper) return;
      if (isPopupOpen()) helper.style.display = "none";
    };

    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(apply, 200);

    apply();
    log("Popup guard enabled");
  }

  function removeKrAnswerHelper() {
    const existing = document.querySelector("#krMergedSuggestions");
    if (existing) existing.remove();
    mergedSuggest.box = null;
    mergedSuggest.input = null;
    mergedSuggest.items = [];
    mergedSuggest.index = -1;
  }

  let toggleCheckboxAdded = false;
  function setupToggleCheckbox(tryInject) {
    const existingToggle = document.getElementById("krHelperToggle");
    if (existingToggle && existingToggle.isConnected) {
      toggleCheckboxAdded = true;
      return;
    }
    toggleCheckboxAdded = false;
    const container = document.getElementById("menuBarOptionContainer");
    if (!container || !container.parentElement) return;
    const wrapper = document.createElement("label");
    wrapper.id = "krHelperToggle";
    wrapper.style.cssText =
      "display:inline-flex;align-items:center;margin-right:8px;cursor:pointer;user-select:none;font-size:12px;";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isEnabled();
    checkbox.style.marginRight = "4px";
    wrapper.appendChild(checkbox);
    wrapper.appendChild(document.createTextNode("KR Helper"));
    checkbox.addEventListener("change", () => {
      setEnabled(checkbox.checked);
      if (checkbox.checked && typeof tryInject === "function") tryInject();
      else removeKrAnswerHelper();
    });
    container.parentElement.insertBefore(wrapper, container);
    toggleCheckboxAdded = true;
  }

  function hasHangul(text) {
    return /[ㄱ-ㅎㅏ-ㅣ가-힣]/.test(text || "");
  }

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function ensureMergedSuggestionBox() {
    let box = document.getElementById("krMergedSuggestions");
    if (!box) {
      box = document.createElement("div");
      box.id = "krMergedSuggestions";
      box.setAttribute("role", "listbox");
      document.body.appendChild(box);
    }
    mergedSuggest.box = box;
    return box;
  }

  function hideMergedSuggestions() {
    const box = mergedSuggest.box || document.getElementById("krMergedSuggestions");
    if (box) {
      box.style.display = "none";
      box.innerHTML = "";
    }
    mergedSuggest.items = [];
    mergedSuggest.index = -1;
  }

  function positionMergedSuggestions(input) {
    const box = mergedSuggest.box;
    if (!box || !input) return;
    const r = input.getBoundingClientRect();
    box.style.left = `${Math.max(4, r.left)}px`;
    box.style.top = `${Math.min(window.innerHeight - 80, r.bottom + 3)}px`;
    box.style.width = `${Math.max(220, r.width)}px`;
  }

  function selectedMergedSuggestion() {
    if (!mergedSuggest.items.length) return "";
    const i = mergedSuggest.index >= 0 ? mergedSuggest.index : 0;
    return mergedSuggest.items[Math.min(i, mergedSuggest.items.length - 1)] || "";
  }

  function renderMergedSuggestions(answerInput) {
    if (!isEnabled() || isPopupOpen()) {
      hideMergedSuggestions();
      return;
    }

    const q = (answerInput.value || "").trim();
    if (!q || !hasHangul(q)) {
      hideMergedSuggestions();
      return;
    }

    const all = cachedData.uniqueKoList || [];
    const starts = [];
    const contains = [];

    for (const ko of all) {
      if (ko.startsWith(q)) starts.push(ko);
      else if (ko.includes(q)) contains.push(ko);
    }

    const items = starts.concat(contains).slice(0, 15);
    if (!items.length) {
      hideMergedSuggestions();
      return;
    }

    const box = ensureMergedSuggestionBox();
    mergedSuggest.input = answerInput;
    mergedSuggest.items = items;
    mergedSuggest.index = 0;

    box.innerHTML = items.map((ko, i) => {
      const row = cachedData.mapKoToEn.get(ko);
      const mapped = row ? (getUseRomaji() ? row.romaji : row.en) : "";
      return `<div class="krMergedItem${i === 0 ? " selected" : ""}" data-index="${i}" role="option">
        ${escapeHtml(ko)}
        ${mapped ? `<small>→ ${escapeHtml(mapped)}</small>` : ""}
      </div>`;
    }).join("");

    positionMergedSuggestions(answerInput);
    box.style.display = "block";

    box.querySelectorAll(".krMergedItem").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const i = Number(el.dataset.index);
        const ko = mergedSuggest.items[i];
        if (ko) submitMappedKorean(answerInput, ko);
      });
    });
  }

  function updateMergedSelection(nextIndex) {
    if (!mergedSuggest.box || !mergedSuggest.items.length) return;
    const count = mergedSuggest.items.length;
    mergedSuggest.index = (nextIndex + count) % count;
    mergedSuggest.box.querySelectorAll(".krMergedItem").forEach((el, i) => {
      el.classList.toggle("selected", i === mergedSuggest.index);
      if (i === mergedSuggest.index) el.scrollIntoView({ block: "nearest" });
    });
  }

  function fireMappedEnter(answerInput) {
    try {
      answerInput.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
      answerInput.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
    } catch (e) {
      warn("Mapped Enter dispatch failed:", e);
    }
  }

  function submitMappedKorean(answerInput, koreanText) {
    const raw = (koreanText || "").trim();
    if (!raw) return false;

    const row = cachedData.mapKoToEn.get(raw);
    if (!row) return false;

    const now = Date.now();
    if (raw === lastSubmitText && now - lastSubmitAt < 250) return true;
    lastSubmitText = raw;
    lastSubmitAt = now;

    const valueToSet = getUseRomaji() ? row.romaji : row.en;
    if (!valueToSet) return false;

    hideMergedSuggestions();

    answerInput.value = valueToSet;
    answerInput.dispatchEvent(new Event("input", { bubbles: true }));
    answerInput.dispatchEvent(new Event("change", { bubbles: true }));

    try { answerInput.focus(); } catch {}

    // AMQ 원래 English/Romaji 자동완성이 input 이벤트를 처리할 시간을 조금 준다.
    setTimeout(() => fireMappedEnter(answerInput), 20);
    return true;
  }

  function bindMergedAnswerInput(answerInput) {
    if (!answerInput || mergedBoundInputs.has(answerInput)) return;

    mergedBoundInputs.add(answerInput);
    answerInput.dataset.krHelperMerged = "true";
    answerInput.title = "English/Romaji 또는 한글 정답을 같은 입력창에서 사용할 수 있습니다.";

    answerInput.addEventListener("input", () => {
      if (!isEnabled()) {
        hideMergedSuggestions();
        return;
      }
      renderMergedSuggestions(answerInput);
    }, true);

    answerInput.addEventListener("keydown", (e) => {
      if (!isEnabled()) return;

      const raw = (answerInput.value || "").trim();
      const koreanMode = hasHangul(raw);

      if (!koreanMode) {
        // 영어/로마자 입력은 AMQ 원래 자동완성과 Enter 동작을 그대로 통과시킨다.
        hideMergedSuggestions();
        return;
      }

      const visible =
        mergedSuggest.box &&
        mergedSuggest.box.style.display !== "none" &&
        mergedSuggest.items.length > 0;

      if (e.key === "ArrowDown" && visible) {
        e.preventDefault();
        e.stopImmediatePropagation();
        updateMergedSelection(mergedSuggest.index + 1);
        return;
      }

      if (e.key === "ArrowUp" && visible) {
        e.preventDefault();
        e.stopImmediatePropagation();
        updateMergedSelection(mergedSuggest.index - 1);
        return;
      }

      if (e.key === "Escape" && visible) {
        e.preventDefault();
        e.stopImmediatePropagation();
        hideMergedSuggestions();
        return;
      }

      if (e.key !== "Enter") return;

      const selected = visible ? selectedMergedSuggestion() : "";
      const target = selected || (cachedData.mapKoToEn.has(raw) ? raw : "");

      if (target) {
        // 한글 원문 Enter는 차단하고 English/Romaji로 변환한 뒤 새 Enter를 보낸다.
        e.preventDefault();
        e.stopImmediatePropagation();
        submitMappedKorean(answerInput, target);
      } else {
        // 매핑이 없는 한글을 그대로 제출하지 않는다.
        e.preventDefault();
        e.stopImmediatePropagation();
        renderMergedSuggestions(answerInput);
      }
    }, true);

    answerInput.addEventListener("focus", () => {
      if (isEnabled() && hasHangul(answerInput.value)) {
        renderMergedSuggestions(answerInput);
      }
    });

    answerInput.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement !== answerInput) hideMergedSuggestions();
      }, 120);
    });

    log("Merged Korean/English answer input attached");
  }

  function injectUI() {
    if (!isEnabled()) {
      removeKrAnswerHelper();
      return false;
    }

    const answerInput =
      typeof pickTopmostVisibleAnswerInput === "function"
        ? pickTopmostVisibleAnswerInput()
        : document.querySelector("#qpAnswerInput");

    if (!answerInput) return false;

    bindMergedAnswerInput(answerInput);
    return true;
  }

  window.addEventListener("resize", () => {
    if (mergedSuggest.input && mergedSuggest.box?.style.display !== "none") {
      positionMergedSuggestions(mergedSuggest.input);
    }
  }, { passive: true });

  window.addEventListener("scroll", () => {
    if (mergedSuggest.input && mergedSuggest.box?.style.display !== "none") {
      positionMergedSuggestions(mergedSuggest.input);
    }
  }, { passive: true, capture: true });

  /** 시트 URL 재요청 후 내용이 바뀌면 캐시 갱신 및 UI 재적용 */
  async function refreshSheetData() {
    try {
      const tsvText = await fetchTSV(SHEET_URL);
      if (tsvText === lastTsvText) return;
      const { mapKoToEn, uniqueKoList, mapEnToKo } = parseTSV(tsvText);
      cachedData.mapKoToEn = mapKoToEn;
      cachedData.uniqueKoList = uniqueKoList;
      cachedData.mapEnToKo = mapEnToKo;
      lastTsvText = tsvText;
      log("시트 변경 감지: 통합 입력 매핑 데이터 자동 갱신됨");
      removeKrAnswerHelper();
      if (typeof window.__krHelperTryInject === "function") window.__krHelperTryInject();
    } catch (err) {
      warn("시트 갱신 실패:", err);
    }
  }

  async function main() {
    try {
      const tsvText = await fetchTSV(SHEET_URL);
      const { mapKoToEn, uniqueKoList, mapEnToKo } = parseTSV(tsvText);
      cachedData.mapKoToEn = mapKoToEn;
      cachedData.uniqueKoList = uniqueKoList;
      cachedData.mapEnToKo = mapEnToKo;
      lastTsvText = tsvText;

      if (mapKoToEn.size === 0) warn("No valid mappings found in sheet");

      const tryInject = () => {
        try {
          setupToggleCheckbox(tryInject);
          injectUI(cachedData.mapKoToEn, cachedData.uniqueKoList);
          removeKrHelperFromNonFirstContainers();
        } catch (e) {
          // silent fail
        }
      };
      window.__krHelperTryInject = tryInject;

      tryInject();
      setupPopupGuard();
      const menuBarCheck = () => {
        if (!toggleCheckboxAdded) setupToggleCheckbox(tryInject);
      };
      menuBarCheck();
      setInterval(menuBarCheck, 1500);

      const observer = new MutationObserver(() => {
        clearTimeout(injectDebounceTimer);
        injectDebounceTimer = setTimeout(tryInject, 80);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });

      setInterval(tryInject, 1500);

      setInterval(refreshSheetData, SHEET_POLL_INTERVAL_MS);
    } catch (err) {
      error("Initialization failed:", err);
    }
  }

  main();

  const multiple_chat_observer = new MutationObserver((mutations) => {
    if (!isEnabled()) return;
    const text1 = document.querySelector("#qpMultipleChoiceEntryOne .qpMultipleChoiceEntryText");
    const text2 = document.querySelector("#qpMultipleChoiceEntryTwo .qpMultipleChoiceEntryText");
    const text3 = document.querySelector("#qpMultipleChoiceEntryThree .qpMultipleChoiceEntryText");
    const text4 = document.querySelector("#qpMultipleChoiceEntryFour .qpMultipleChoiceEntryText");

    const texts = [text1, text2, text3, text4];

    function fontSizeByKoreanLength(len) {
      if (len <= 12) return "18px";
      if (len <= 20) return "14px";
      if (len <= 28) return "12px";
      return "10px";
    }

    function unzip_map() {
      const unzip_mapEnToKo = cachedData.mapEnToKo;
      texts.forEach((element) => {
        if (!element) return;
        const currentText = element.textContent;
        const arr = unzip_mapEnToKo.get(currentText) || [];
        const ko = arr[0];
        if (ko !== undefined && currentText !== ko) {
          element.textContent = ko;
          element.style.fontSize = fontSizeByKoreanLength(ko.length);
        }
      });
    }
    unzip_map();
  });

  let observedMultipleContainer = null;
  const multiple_observer = new MutationObserver(() => {
    const container = document.getElementById("qpMultipleChoiceContainer");
    if (!container || container === observedMultipleContainer) return;
    try { multiple_chat_observer.disconnect(); } catch {}
    observedMultipleContainer = container;
    multiple_chat_observer.observe(container, { childList: true, subtree: true });
  });

  const mainContainer = document.getElementById("mainContainer") || document.documentElement;
  multiple_observer.observe(mainContainer, { childList: true, subtree: true });
  setTimeout(() => {
    const container = document.getElementById("qpMultipleChoiceContainer");
    if (container) {
      observedMultipleContainer = container;
      multiple_chat_observer.observe(container, { childList: true, subtree: true });
    }
  }, 500);
})();
