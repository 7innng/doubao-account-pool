(function () {
  "use strict";

  const INSTALL_KEY = "__watermarkFreeDuration30Installed";
  const DURATION_KEY = "intl_dola_enable_30s_v1";
  const STATE_ATTRIBUTE = "data-watermark-free-duration-30";
  const STATE_EVENT = "watermark-free-duration-30-change";
  const MENU_MARK = "data-watermark-free-duration-option";
  const NATIVE_BOUND_MARK = "data-watermark-free-native-duration-bound";
  const MODEL_SELECTOR = "[data-input-engine-actionbar-control-key=\"video-model\"], [data-input-engine-actionbar-control-key=\"model\"]";
  const VIDEO_COMPLETION_PATH = "/chat/completion";
  const VIDEO_ABILITY_TYPE = 17;
  const SEEDANCE_25_MODEL = "seedance_v2.5";

  if (globalThis[INSTALL_KEY]) {
    return;
  }
  globalThis[INSTALL_KEY] = true;

  const host = location.hostname.replace(/^www\./i, "").toLowerCase();
  if (!(host === "dola.com" || host.endsWith(".dola.com"))) {
    return;
  }

  let lastKnownModelTarget = 0;

  function textOf(element) {
    return String(
      element?.textContent ||
      element?.getAttribute?.("aria-label") ||
      element?.getAttribute?.("title") ||
      ""
    ).replace(/\s+/g, " ").trim();
  }

  function visible(element) {
    try {
      const rect = element?.getBoundingClientRect();
      const style = element && getComputedStyle(element);
      return Boolean(
        element &&
        element.isConnected &&
        rect.width > 1 &&
        rect.height > 1 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || 1) > 0.01
      );
    } catch {
      return false;
    }
  }

  function durationText(value) {
    return String(value || "").replace(/\s+/g, "").replace(/[✓✔√]/g, "").trim();
  }

  function selectedModelText() {
    return durationText(textOf(document.querySelector(MODEL_SELECTOR)));
  }

  function modelTargetDuration() {
    const text = selectedModelText();
    if (/2\.5|seedance[^\d]*2[^\d]*5/i.test(text)) {
      lastKnownModelTarget = 30;
    } else if (/2\.0|seedance[^\d]*2[^\d]*0|seedance[^\d]*fast/i.test(text)) {
      lastKnownModelTarget = 0;
    }
    return lastKnownModelTarget;
  }

  function duration30Enabled() {
    try {
      return localStorage.getItem(DURATION_KEY) === "1";
    } catch {
      return false;
    }
  }

  function selectedDuration() {
    return modelTargetDuration() === 30 && duration30Enabled() ? 30 : 0;
  }

  function publishDurationState() {
    const root = document.documentElement;
    if (!root) {
      return;
    }
    root.setAttribute(STATE_ATTRIBUTE, duration30Enabled() ? "1" : "0");
    document.dispatchEvent(new Event(STATE_EVENT));
  }

  function saveDuration30(enabled) {
    try {
      localStorage.setItem(DURATION_KEY, enabled ? "1" : "0");
    } catch {
      return;
    }
    publishDurationState();
  }

  document.addEventListener(STATE_EVENT, () => {
    const value = document.documentElement?.getAttribute(STATE_ATTRIBUTE);
    if (value !== "0" && value !== "1") {
      return;
    }
    try {
      localStorage.setItem(DURATION_KEY, value);
    } catch {
      return;
    }
    enhanceDurationOptions();
  });

  function getRequestUrl(input) {
    return typeof input === "string" ? input : (input && (input.url || input.href)) || String(input || "");
  }

  function isSupportedGenerationHost(rawUrl) {
    try {
      const requestHost = new URL(rawUrl, location.href).hostname.replace(/^www\./i, "").toLowerCase();
      return requestHost === "dola.com" || requestHost.endsWith(".dola.com");
    } catch {
      return false;
    }
  }

  function isVideoCompletionUrl(rawUrl) {
    if (!isSupportedGenerationHost(rawUrl || location.href)) {
      return false;
    }
    try {
      return new URL(rawUrl, location.href).pathname === VIDEO_COMPLETION_PATH;
    } catch {
      return false;
    }
  }

  function patchBody(body, requestUrl = "") {
    if (!duration30Enabled() || typeof body !== "string" || !body.trim() || !isVideoCompletionUrl(requestUrl)) {
      return body;
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return body;
    }

    const ability = payload?.chat_ability;
    if (!ability || Number(ability.ability_type) !== VIDEO_ABILITY_TYPE || typeof ability.ability_param !== "string") {
      return body;
    }

    let abilityParam;
    try {
      abilityParam = JSON.parse(ability.ability_param);
    } catch {
      return body;
    }
    if (!abilityParam || abilityParam.model !== SEEDANCE_25_MODEL || Number(abilityParam.duration) === 30) {
      return body;
    }

    abilityParam.duration = 30;
    ability.ability_param = JSON.stringify(abilityParam);
    return JSON.stringify(payload);
  }

  function patchRequests() {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = function patchedFetch(input, init = {}) {
        if (init && typeof init.body === "string") {
          const requestUrl = getRequestUrl(input);
          const body = patchBody(init.body, requestUrl);
          if (body !== init.body) {
            init = { ...init, body };
          }
        }
        return originalFetch.call(this, input, init);
      };
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    if (typeof originalOpen === "function") {
      XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
        this.__watermarkFreeRequestUrl = getRequestUrl(url);
        return originalOpen.apply(this, arguments);
      };
    }
    if (typeof originalSend === "function") {
      XMLHttpRequest.prototype.send = function patchedSend(body) {
        return originalSend.call(this, patchBody(body, this.__watermarkFreeRequestUrl || location.href));
      };
    }
  }

  function exactDuration(element) {
    const match = durationText(textOf(element)).match(/^(5|10|15|30)(s|秒)$/i);
    return match ? Number(match[1]) : 0;
  }

  function findDurationMenuRoot() {
    const candidates = Array.from(document.querySelectorAll(
      "[role=\"menu\"], [role=\"listbox\"], [data-slot*=\"dropdown-menu\"], [class*=\"popover\"], [class*=\"dropdown\"], div"
    ))
      .filter((element) => visible(element))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width < 70 || rect.width > 520 || rect.height < 40 || rect.height > 520) {
          return false;
        }
        const text = durationText(textOf(element));
        const hasNativeDurations = /5(s|秒)/i.test(text) && /10(s|秒)/i.test(text);
        const looksLikeWholeToolbar = /Seedance|比例|参考图|模型|Model|Fast/i.test(text) && rect.width > 360;
        return hasNativeDurations && !looksLikeWholeToolbar;
      })
      .sort((first, second) => {
        const firstRect = first.getBoundingClientRect();
        const secondRect = second.getBoundingClientRect();
        return firstRect.width * firstRect.height - secondRect.width * secondRect.height;
      });
    return candidates[0] || null;
  }

  function replaceDurationLabel(element, target) {
    try {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let changed = false;
      while (walker.nextNode()) {
        const next = String(walker.currentNode.nodeValue || "").replace(/(?:5|10|15|30)(s|秒)/ig, `${target}s`);
        if (next !== walker.currentNode.nodeValue) {
          walker.currentNode.nodeValue = next;
          changed = true;
        }
      }
      if (changed) {
        return;
      }
    } catch {
      // Fall through to replacing the whole label.
    }
    element.textContent = `${target}s`;
  }

  function durationCheckMarks(item) {
    return Array.from(item?.querySelectorAll?.("svg") || []);
  }

  function setDurationMenuSelected(item, selected) {
    item?.setAttribute?.("aria-selected", selected ? "true" : "false");
    if (selected) {
      item?.setAttribute?.("data-state", "checked");
    } else {
      item?.removeAttribute?.("data-state");
    }
    for (const mark of durationCheckMarks(item)) {
      mark.style.visibility = selected ? "visible" : "hidden";
    }
  }

  function syncDurationMenuSelection(root) {
    if (!root) {
      return;
    }
    const force30 = selectedDuration() === 30;
    const options = Array.from(root.querySelectorAll("[role=\"menuitem\"], [role=\"option\"], li, button, div"))
      .filter((element) => element !== root && visible(element) && exactDuration(element) > 0);
    for (const option of options) {
      const value = exactDuration(option);
      if (force30) {
        setDurationMenuSelected(option, value === 30);
      } else if (option.getAttribute(MENU_MARK) === "30") {
        setDurationMenuSelected(option, false);
      }
    }
  }

  function updateToolbarDurationText(seconds) {
    if (!document.body) {
      return;
    }
    const menuRoot = findDurationMenuRoot();
    const isInMenu = (element) => Boolean(
      element && (menuRoot?.contains?.(element) || element.closest?.("[role=\"menu\"], [role=\"listbox\"], [data-slot=\"dropdown-menu-content\"]"))
    );
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!/^\s*(5|10|15|30)s\s*$/i.test(node.nodeValue || "")) {
        continue;
      }
      const element = node.parentElement;
      if (!visible(element) || isInMenu(element)) {
        continue;
      }
      const trigger = element.closest?.("button, [role=\"button\"], [aria-haspopup], [aria-expanded], [data-slot*=\"trigger\"]") || element;
      if (visible(trigger) && !isInMenu(trigger)) {
        node.nodeValue = `${seconds}s`;
      }
    }
  }

  function holdToolbarDurationText(seconds) {
    for (const delay of [0, 50, 120, 300, 800, 1500, 3000]) {
      setTimeout(() => updateToolbarDurationText(seconds), delay);
    }
  }

  function injectDurationMenuOption() {
    const root = findDurationMenuRoot();
    if (!root) {
      return false;
    }

    const target = modelTargetDuration();
    let options = Array.from(root.querySelectorAll("[role=\"menuitem\"], [role=\"option\"], li, button, div"))
      .filter((element) => element !== root && visible(element) && exactDuration(element) > 0);

    for (const option of options) {
      if (option.getAttribute(MENU_MARK) === "30" && target !== 30) {
        option.remove();
      }
    }

    options = Array.from(root.querySelectorAll("[role=\"menuitem\"], [role=\"option\"], li, button, div"))
      .filter((element) => element !== root && visible(element) && exactDuration(element) > 0);

    if (target === 30 && !options.some((element) => exactDuration(element) === 30)) {
      const template = options.find((element) => exactDuration(element) === 10) || options[0];
      if (!template?.parentElement) {
        return false;
      }
      const clone = template.cloneNode(true);
      clone.removeAttribute("aria-selected");
      clone.removeAttribute("data-state");
      clone.setAttribute(MENU_MARK, "30");
      clone.setAttribute("aria-selected", "false");
      replaceDurationLabel(clone, 30);
      for (const mark of durationCheckMarks(clone)) {
        mark.style.visibility = "hidden";
      }
      clone.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        saveDuration30(true);
        syncDurationMenuSelection(root);
        holdToolbarDurationText(30);
        setTimeout(() => {
          try {
            const options = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
            document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", options));
            document.dispatchEvent(new KeyboardEvent("keydown", options));
            document.dispatchEvent(new KeyboardEvent("keyup", options));
          } catch {
            document.body?.click?.();
          }
        }, 60);
      }, true);
      template.parentElement.appendChild(clone);
    }

    options = Array.from(root.querySelectorAll("[role=\"menuitem\"], [role=\"option\"], li, button, div"))
      .filter((element) => element !== root && visible(element) && exactDuration(element) > 0);
    for (const option of options) {
      const value = exactDuration(option);
      if ((value === 5 || value === 10 || value === 15) && !option.hasAttribute(NATIVE_BOUND_MARK)) {
        option.setAttribute(NATIVE_BOUND_MARK, String(value));
        option.addEventListener("click", () => saveDuration30(false), true);
      }
    }

    syncDurationMenuSelection(root);
    return true;
  }

  function enhanceDurationOptions() {
    injectDurationMenuOption();
    if (selectedDuration() === 30) {
      updateToolbarDurationText(30);
    }
  }

  patchRequests();
  publishDurationState();
  enhanceDurationOptions();
  setInterval(enhanceDurationOptions, 1000);
})();
