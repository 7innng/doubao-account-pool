(function () {
  const PANEL_ID = "watermark-free-media-panel";
  const INSTANCE_KEY = "__watermarkFreeMediaPanelActive";
  const DURATION_KEY = "intl_dola_enable_30s_v1";
  const DURATION_STATE_ATTRIBUTE = "data-watermark-free-duration-30";
  const DURATION_STATE_EVENT = "watermark-free-duration-30-change";
  const MEDIA_EVENT = "dola-media-items";
  const MINIMIZED_KEY = "intl_dola_media_panel_minimized_v1";
  const items = new Map();

  if (globalThis[INSTANCE_KEY]) {
    return;
  }
  globalThis[INSTANCE_KEY] = true;

  const existingHost = document.getElementById(PANEL_ID);
  existingHost?.remove();

  const host = document.createElement("div");
  host.id = PANEL_ID;
  forceHostVisible();
  mountHost();

  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        font-family: Arial, "Microsoft YaHei", sans-serif;
      }

      .panel {
        width: 336px;
        max-height: 420px;
        box-sizing: border-box;
        display: flex;
        flex-direction: column;
        color: #1f2937;
        background: #fff;
        border: 1px solid rgba(31, 41, 55, 0.16);
        border-radius: 8px;
        box-shadow: 0 14px 38px rgba(15, 23, 42, 0.2);
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        background: #f8fafc;
        border-bottom: 1px solid rgba(31, 41, 55, 0.1);
      }

      .panel-toggle {
        width: 30px;
        min-width: 30px;
        height: 30px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid rgba(31, 41, 55, 0.12);
        border-radius: 6px;
        background: #fff;
        color: #334155;
        font-size: 18px;
        line-height: 1;
      }

      .panel-toggle:hover {
        background: #eff6ff;
        color: #1d4ed8;
      }

      .panel-toggle-icon {
        display: block;
        width: 14px;
        height: 14px;
        line-height: 12px;
        text-align: center;
      }

      .title {
        font-size: 14px;
        line-height: 20px;
        font-weight: 700;
      }

      .count {
        min-width: 22px;
        height: 20px;
        padding: 0 6px;
        border-radius: 999px;
        background: #166534;
        color: #fff;
        font-size: 12px;
        line-height: 20px;
        text-align: center;
      }

      .duration-control {
        min-height: 38px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 0 12px;
        border-bottom: 1px solid rgba(31, 41, 55, 0.1);
        background: #fff;
        color: #334155;
        font-size: 12px;
      }

      .duration-control label {
        display: flex;
        align-items: center;
        gap: 7px;
        font-weight: 700;
        cursor: pointer;
      }

      .duration-control input {
        width: 16px;
        height: 16px;
        margin: 0;
        accent-color: #2563eb;
      }

      .duration-state {
        color: #64748b;
        font-variant-numeric: tabular-nums;
      }

      .duration-state.enabled {
        color: #166534;
        font-weight: 700;
      }

      .list {
        min-height: 76px;
        max-height: 350px;
        overflow: auto;
        padding: 8px;
      }

      .empty {
        padding: 18px 10px;
        color: #64748b;
        font-size: 13px;
        line-height: 20px;
        text-align: center;
      }

      .item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
        padding: 8px;
        border: 1px solid rgba(31, 41, 55, 0.12);
        border-radius: 6px;
        background: #fff;
      }

      .item + .item {
        margin-top: 8px;
      }

      .label {
        min-width: 0;
        color: #273444;
        font-size: 13px;
        line-height: 18px;
        font-weight: 700;
      }

      .tag {
        display: inline-block;
        min-width: 34px;
        margin-right: 8px;
        padding: 2px 6px;
        border-radius: 999px;
        color: #fff;
        font-size: 12px;
        line-height: 16px;
        text-align: center;
      }

      .tag.video {
        background: #6d28d9;
      }

      .tag.image {
        background: #0f766e;
      }

      button {
        height: 30px;
        padding: 0 10px;
        border: 0;
        border-radius: 6px;
        background: #2563eb;
        color: #fff;
        font-size: 12px;
        line-height: 30px;
        cursor: pointer;
      }

      button:hover {
        background: #1d4ed8;
      }

      :host([data-minimized="1"]) {
        right: 0 !important;
        bottom: 0 !important;
      }

      :host([data-minimized="1"]) .panel {
        width: 32px;
        height: 32px;
        min-height: 32px;
        max-height: 32px;
        border-radius: 6px;
      }

      :host([data-minimized="1"]) .header {
        width: 32px;
        height: 32px;
        padding: 0;
        border-bottom: 0;
        background: #eff6ff;
      }

      :host([data-minimized="1"]) .title,
      :host([data-minimized="1"]) .count,
      :host([data-minimized="1"]) .duration-control,
      :host([data-minimized="1"]) .list {
        display: none;
      }

      :host([data-minimized="1"]) .panel-toggle {
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: #1d4ed8;
      }

      :host([data-minimized="1"]) .panel-toggle-icon {
        width: 12px;
        height: 12px;
        border: 1.5px solid currentColor;
        border-radius: 2px;
        font-size: 0;
      }
    </style>
    <section class="panel" aria-label="无水印资源面板">
      <div class="header">
        <div class="title">无水印资源</div>
        <div class="count">0</div>
        <button class="panel-toggle" type="button" aria-label="最小化资源面板" title="最小化资源面板">
          <span class="panel-toggle-icon" aria-hidden="true">−</span>
        </button>
      </div>
      <div class="duration-control">
        <label><input class="duration-toggle" type="checkbox"> Seedance 2.5</label>
        <span class="duration-state">30s 关闭</span>
      </div>
      <div class="list">
        <div class="empty">等待捕获资源</div>
      </div>
    </section>
  `;

  const list = shadow.querySelector(".list");
  const count = shadow.querySelector(".count");
  const durationToggle = shadow.querySelector(".duration-toggle");
  const durationState = shadow.querySelector(".duration-state");
  const durationControl = shadow.querySelector(".duration-control");
  const panelToggle = shadow.querySelector(".panel-toggle");
  const panelToggleIcon = shadow.querySelector(".panel-toggle-icon");
  const durationControlSupported = /(^|\.)dola\.com$/i.test(location.hostname);
  let currentSourceKey = "";
  let statusText = "等待捕获资源";
  let minimized = false;

  function readMinimizedState() {
    try {
      return localStorage.getItem(MINIMIZED_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setMinimizedState(nextValue, persist = true) {
    minimized = Boolean(nextValue);
    if (minimized) {
      host.setAttribute("data-minimized", "1");
    } else {
      host.removeAttribute("data-minimized");
    }
    if (persist) {
      try {
        localStorage.setItem(MINIMIZED_KEY, minimized ? "1" : "0");
      } catch {
        // Keep the current visual state when storage is unavailable.
      }
    }
    const label = minimized ? "展开资源面板" : "最小化资源面板";
    panelToggle.setAttribute("aria-label", label);
    panelToggle.setAttribute("title", label);
    panelToggleIcon.textContent = minimized ? "" : "−";
  }

  setMinimizedState(readMinimizedState(), false);
  panelToggle.addEventListener("click", () => {
    setMinimizedState(!minimized);
  });
  if (durationControlSupported) {
    syncDurationControl();
    durationToggle.addEventListener("change", () => {
      setDuration30Enabled(durationToggle.checked);
    });
    document.addEventListener(DURATION_STATE_EVENT, syncDurationControl);
  } else {
    durationControl.remove();
  }

  document.addEventListener(MEDIA_EVENT, (event) => {
    try {
      const message = JSON.parse(event.detail || "{}");
      resetForSource(message.sourceKey);
      addItems(message.items || []);
      statusText = items.size ? "" : "未提取到资源";
      render();
    } catch {
      statusText = "媒体数据解析失败";
      render();
    }
  });

  function resetForSource(sourceKey) {
    if (typeof sourceKey !== "string" || !sourceKey) {
      return;
    }

    if (sourceKey !== currentSourceKey) {
      currentSourceKey = sourceKey;
      items.clear();
      statusText = "";
    }
  }

  function duration30Enabled() {
    try {
      return localStorage.getItem(DURATION_KEY) === "1";
    } catch {
      return false;
    }
  }

  function setDuration30Enabled(enabled) {
    try {
      localStorage.setItem(DURATION_KEY, enabled ? "1" : "0");
    } catch {
      return;
    }
    document.documentElement?.setAttribute(DURATION_STATE_ATTRIBUTE, enabled ? "1" : "0");
    document.dispatchEvent(new Event(DURATION_STATE_EVENT));
    syncDurationControl();
  }

  function syncDurationControl() {
    const enabled = duration30Enabled();
    durationToggle.checked = enabled;
    durationState.textContent = enabled ? "30s 开启" : "30s 关闭";
    durationState.classList.toggle("enabled", enabled);
  }

  function render() {
    count.textContent = String(items.size);
    list.textContent = "";

    if (!items.size) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = statusText || "等待捕获资源";
      list.appendChild(empty);
      return;
    }

    Array.from(items.values()).forEach((item, index) => {
      const row = document.createElement("div");
      row.className = "item";

      const label = document.createElement("div");
      label.className = "label";
      label.title = item.url;

      const tag = document.createElement("span");
      tag.className = `tag ${item.type}`;
      tag.textContent = item.type === "image" ? "图片" : "视频";

      const indexText = document.createElement("span");
      indexText.textContent = String(index + 1);

      label.append(tag, indexText);

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "下载";
      button.addEventListener("click", () => {
        const anchor = document.createElement("a");
        anchor.href = item.url;
        anchor.download = "";
        anchor.rel = "noopener noreferrer";
        anchor.click();
      });

      row.append(label, button);
      list.appendChild(row);
    });
  }

  function addItems(nextItems) {
    for (const item of nextItems) {
      if (!item || typeof item.url !== "string" || !isHttpUrl(item.url)) {
        continue;
      }
      items.set(item.url, {
        type: item.type === "image" ? "image" : "video",
        url: item.url
      });
    }
  }

  function isHttpUrl(url) {
    return /^https?:\/\//i.test(url);
  }

  function forceHostVisible() {
    const properties = {
      all: "initial",
      display: "block",
      position: "fixed",
      right: "16px",
      bottom: "16px",
      width: "auto",
      height: "auto",
      visibility: "visible",
      opacity: "1",
      "pointer-events": "auto",
      "z-index": "2147483647"
    };
    for (const [name, value] of Object.entries(properties)) {
      host.style.setProperty(name, value, "important");
    }
  }

  function mountHost() {
    if (!host.isConnected && document.documentElement) {
      document.documentElement.appendChild(host);
    }
  }

  const hostObserver = new MutationObserver(() => {
    const currentHost = document.getElementById(PANEL_ID);
    if (currentHost && currentHost !== host) {
      hostObserver.disconnect();
      return;
    }
    mountHost();
  });
  hostObserver.observe(document.documentElement, { childList: true });
})();
