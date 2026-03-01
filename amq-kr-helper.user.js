// ==UserScript==
// @name         AMQ KR Helper (DOM inject, no jQuery)
// @namespace    amq-kr-helper
// @version      1.14
// @description  다음문제 갔을때 자동으로 한글정답 입력칸에 포커싱
// @author       You
// @match        https://animemusicquiz.com/*
// @run-at       document-end
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  "use strict";

  const SHEET_URL =
    "https://docs.google.com/spreadsheets/d/19-YDyMy__mPoP5Ozi7nPJ-A83XwsljODhhqmzuv1P2g/export?format=tsv&gid=0";

  const TAG = "[KR Helper]";
  const STORAGE_KEY = "amq-kr-helper-enabled";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const error = (...a) => console.error(TAG, ...a);

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
    const response = await fetch(url);
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
    const containers = document.querySelectorAll(
      "[id='qpAnswerInputContainer'], .qpAnswerInputContainer"
    );
    if (containers.length <= 1) return;

    for (let i = 1; i < containers.length; i++) {
      const helper = containers[i].querySelector("[id='krAnswerHelper']");
      if (helper) helper.remove();
    }
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
      const helper = document.querySelector("#krAnswerHelper");
      if (!helper) return;
      helper.style.display = isPopupOpen() ? "none" : "";
    };

    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    setInterval(apply, 200);

    apply();
    log("Popup guard enabled");
  }

  function removeKrAnswerHelper() {
    const existing = document.querySelector("#krAnswerHelper");
    if (existing) existing.remove();
  }

  let toggleCheckboxAdded = false;
  function setupToggleCheckbox(tryInject) {
    if (toggleCheckboxAdded) return;
    const container = document.getElementById("menuBarOptionContainer");
    if (!container || !container.parentElement) return;
    const wrapper = document.createElement("label");
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

  function injectUI(mapKoToEn, uniqueKoList) {
    if (!isEnabled()) {
      removeKrAnswerHelper();
      return false;
    }
    const answerInput =
      typeof pickTopmostVisibleAnswerInput === "function"
        ? pickTopmostVisibleAnswerInput()
        : document.querySelector("#qpAnswerInput");
    if (!answerInput) return false;

    const existing = document.querySelector("#krAnswerHelper");
    if (existing) {
      const hostNow = answerInput.parentElement;
      if (hostNow && hostNow.contains(existing)) return true;
      existing.remove();
    }

    const host = answerInput.parentElement;
    if (!host) return false;

    const wrapper = document.createElement("div");
    wrapper.id = "krAnswerHelper";
    wrapper.style.marginTop = "6px";
    wrapper.style.width = "100%";
    wrapper.style.overflow = "visible";

    wrapper.innerHTML = `
      <input id="krAnswerInput" type="text" class="flatTextInput"
        style="width:100%; box-sizing:border-box;"
        placeholder="한글 정답 입력 (드롭다운에서 선택 시에만 반영) 선택 후 제출은 별도로 해야함"
        autocomplete="off" />
    `;

    answerInput.insertAdjacentElement("afterend", wrapper);

    const krInput = document.querySelector("#krAnswerInput");
    if (!krInput) return false;

    const applyToAnswerAndSubmit = (text) => {
      const raw = (text ?? "").trim();
      if (!raw) return;

      const row = mapKoToEn.get(raw);
      const valueToSet = row
        ? (getUseRomaji() ? row.romaji : row.en)
        : raw;

      answerInput.value = valueToSet;
      answerInput.dispatchEvent(new Event("input", { bubbles: true }));

      const fireEnter = () => {
        try {
          answerInput.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true })
          );
          answerInput.dispatchEvent(
            new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true })
          );
        } catch {}
      };

      try {
        answerInput.focus();
      } catch {}

      fireEnter();
      setTimeout(fireEnter, 25);
    };

    krInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;

      e.preventDefault();
      e.stopPropagation();

      if (!isDropdownVisible()) return;

      const selected = getSelectedDropdownItem(krInput);
      if (selected) {
        applyToAnswerAndSubmit(selected);
      }
    });

    let dropdownAttached = false;

    if (typeof unsafeWindow.AmqAwesomeplete === "function") {
      try {
        new unsafeWindow.AmqAwesomeplete(
          krInput,
          { list: uniqueKoList, minChars: 1, maxItems: 15, autoFirst: true },
          true
        );
        krInput.addEventListener("awesomplete-selectcomplete", (e) => {
          const selected = (e.text?.value ?? e.text ?? "").trim();
          applyToAnswerAndSubmit(selected);
        });
        dropdownAttached = true;
        log("Awesomplete attached successfully");
      } catch (err) {
        warn("Awesomplete failed to attach:", err);
      }
    } else {
      warn("AmqAwesomeplete not available");
    }

    if (!dropdownAttached && uniqueKoList.length > 0) {
      attachDatalistFallback(krInput, uniqueKoList);
      krInput.addEventListener("change", () => {
        if (krInput.value.trim()) applyToAnswerAndSubmit(krInput.value);
      });
    }

    let lastAnswerValue = "";
    setInterval(() => {
      const qp =
        typeof pickTopmostVisibleAnswerInput === "function"
          ? pickTopmostVisibleAnswerInput()
          : document.querySelector("#qpAnswerInput");

      const kr = document.querySelector("#krAnswerInput");
      if (!qp || !kr) return;

      if (!qp.value && lastAnswerValue) {
        kr.value = "";
        if (isEnabled()) {
          try {
            kr.focus();
          } catch (e) {}
        }
      }
      lastAnswerValue = qp.value;
    }, 300);

    log("KR Helper UI injected");
    return true;
  }

  async function main() {
    let mapEnToKo = new Map();
    try {
      const tsvText = await fetchTSV(SHEET_URL);
      const { mapKoToEn, uniqueKoList, mapEnToKo: parsedEnToKo } = parseTSV(tsvText);
      mapEnToKo = parsedEnToKo;

      if (mapKoToEn.size === 0) warn("No valid mappings found in sheet");

      const tryInject = () => {
        try {
          setupToggleCheckbox(tryInject);
          injectUI(mapKoToEn, uniqueKoList);
          removeKrHelperFromNonFirstContainers();
        } catch (e) {
          // silent fail
        }
      };

      tryInject();
      setupPopupGuard();
      const menuBarCheck = () => {
        if (!toggleCheckboxAdded) setupToggleCheckbox(tryInject);
      };
      menuBarCheck();
      setInterval(menuBarCheck, 1500);

      const observer = new MutationObserver(tryInject);
      observer.observe(document.documentElement, { childList: true, subtree: true });

      setInterval(tryInject, 1000);
    } catch (err) {
      error("Initialization failed:", err);
    }
    return mapEnToKo;
  }

  const mapEnToKo = main();

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

    async function unzip_map() {
      const unzip_mapEnToKo = await mapEnToKo;
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

  const multiple_observer = new MutationObserver(() => {
    if (document.getElementById("qpMultipleChoiceContainer")) {
      multiple_observer.disconnect();
      multiple_chat_observer.observe(document.getElementById("qpMultipleChoiceContainer"), {
        childList: true,
        subtree: true,
      });
    }
  });

  multiple_observer.observe(document.getElementById("mainContainer"), {
    childList: true,
    subtree: true,
  });
})();
