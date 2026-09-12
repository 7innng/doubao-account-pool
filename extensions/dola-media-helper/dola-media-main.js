(function () {
  "use strict";

  const INSTALL_KEY = "__dolaMediaCaptureInstalled";
  const MEDIA_EVENT = "dola-media-items";
  const CHAIN_PATH = "/im/chain/single";
  const MAX_FALLBACK_API_COUNT = 8;
  const FALLBACK_API_TIMEOUT_MS = 8000;
  const QAAB_SALT_HEX = "4dd4c2e6b83162090e52b3c7a6733ba4"
    + "1cb2462b829ab58a196b39db57177524"
    + "f49baf7f08e8d68d26a72e37c1a95a2f"
    + "1f05a51892aef2949732b62a38aadd58";

  if (globalThis[INSTALL_KEY]) return;
  globalThis[INSTALL_KEY] = true;

  const host = location.hostname.replace(/^www\./i, "").toLowerCase();
  if (!(host === "dola.com" || host.endsWith(".dola.com"))) return;

  const rawFetch = window.fetch.bind(window);

  function isChainResponse(rawUrl) {
    try {
      const url = new URL(rawUrl, location.href);
      const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
      return (hostname === "dola.com" || hostname.endsWith(".dola.com"))
        && url.pathname === CHAIN_PATH;
    } catch {
      return false;
    }
  }

  function requestUrl(input) {
    return typeof input === "string" ? input : (input && (input.url || input.href)) || "";
  }

  window.fetch = async function dolaMediaFetch(input, init) {
    const response = await rawFetch(input, init);
    if (isChainResponse(requestUrl(input))) {
      void response.clone().text().then(inspectResponse).catch(() => undefined);
    }
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function dolaMediaOpen(method, url) {
    this.__dolaMediaUrl = requestUrl(url);
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function dolaMediaSend(body) {
    if (isChainResponse(this.__dolaMediaUrl || "")) {
      this.addEventListener("loadend", () => {
        if (this.responseType === "" || this.responseType === "text") {
          void inspectResponse(String(this.responseText || ""));
        }
      }, { once: true });
    }
    return originalSend.call(this, body);
  };

  async function inspectResponse(rawBody) {
    let json;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return;
    }

    const items = [];
    const seen = new Set();
    for (const url of findImageUrls(json)) addItem(items, seen, "image", url, true);

    const fallbackApis = findFallbackApis(json, rawBody).slice(0, MAX_FALLBACK_API_COUNT);
    const videos = await Promise.all(fallbackApis.map(getUnwatermarkedVideoUrl));
    for (const url of videos) addItem(items, seen, "video", url, true);

    for (const url of findDirectVideoUrls(json)) addItem(items, seen, "video", url, false);
    if (!items.length) return;

    const captured = Array.isArray(globalThis.__dolaMediaItems) ? globalThis.__dolaMediaItems : [];
    const byUrl = new Map(captured.map((item) => [item.url, item]));
    for (const item of items) byUrl.set(item.url, item);
    globalThis.__dolaMediaItems = Array.from(byUrl.values()).slice(-100);

    document.dispatchEvent(new CustomEvent(MEDIA_EVENT, {
      detail: JSON.stringify({ sourceKey: location.href, items })
    }));
  }

  function findImageUrls(value) {
    const urls = [];
    walkJsonAndStrings(value, (node) => {
      const image = node && !Array.isArray(node) ? node.image_ori_raw : null;
      if (image && typeof image === "object" && isHttpUrl(image.url)) urls.push(image.url);
    });
    return urls;
  }

  function findDirectVideoUrls(value) {
    const urls = [];
    const keys = new Set(["download_url", "origin_url", "play_url", "video_url"]);
    walkJsonAndStrings(value, (node) => {
      if (!node || Array.isArray(node)) return;
      for (const [key, candidate] of Object.entries(node)) {
        if (!keys.has(key) || typeof candidate !== "string") continue;
        const decoded = decodeJsonEscapedFragment(candidate);
        if (isHttpUrl(decoded)) urls.push(decoded);
      }
    });
    return urls;
  }

  function findFallbackApis(json, rawBody) {
    const apis = new Set();
    for (const value of findValuesByKey(json, "fallback_api")) addFallbackApi(apis, value);
    for (const pattern of [/fallback_api\\":\\"(.*?)\\"/g, /"fallback_api"\s*:\s*"([^"]+)"/g]) {
      let match = pattern.exec(rawBody);
      while (match) {
        addFallbackApi(apis, decodeJsonEscapedFragment(match[1]));
        match = pattern.exec(rawBody);
      }
    }
    return Array.from(apis);
  }

  function addFallbackApi(apis, value) {
    if (typeof value !== "string") return;
    const url = decodeJsonEscapedFragment(value);
    if (isAllowedFallbackApiUrl(url)) apis.add(url);
  }

  function isAllowedFallbackApiUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
      return url.protocol === "https:" && ["dola.com", "byteintlapi.com"].some(
        (root) => hostname === root || hostname.endsWith(`.${root}`)
      );
    } catch {
      return false;
    }
  }

  async function getUnwatermarkedVideoUrl(fallbackApi) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FALLBACK_API_TIMEOUT_MS);
    try {
      const url = replaceQueryParams(fallbackApi, {
        channel: "no",
        codec_type: "8",
        logo_type: "unwatermarked"
      });
      const response = await rawFetch(url, {
        method: "GET",
        credentials: "omit",
        signal: controller.signal,
        headers: { accept: "application/json,text/plain,*/*" }
      });
      if (!response.ok || (response.url && !isAllowedFallbackApiUrl(response.url))) return "";
      const payload = await response.json();
      const data = getVideoData(payload);
      const token = pickMainUrlToken(data);
      if (!token) return "";
      const keySeed = findKeySeedDeep(payload) || getQueryParam(url, "key_seed");
      return await decodeMainUrl(token, keySeed);
    } catch {
      return "";
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function replaceQueryParams(rawUrl, params) {
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  function getQueryParam(rawUrl, name) {
    try {
      return new URL(rawUrl).searchParams.get(name)?.trim() || "";
    } catch {
      return "";
    }
  }

  function getVideoData(payload) {
    const videoInfo = payload?.video_info || payload?.data?.video_info || payload;
    const data = videoInfo?.data || videoInfo;
    return data && typeof data === "object" ? data : {};
  }

  function pickMainUrlToken(data) {
    const list = data?.video_list;
    const entries = list && typeof list === "object" && Object.keys(list).length
      ? Object.values(list)
      : [data];
    let best = null;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const token = entry.main_url || entry.play_url || "";
      if (typeof token !== "string" || !token.trim()) continue;
      const score = Number(entry.bitrate || entry.real_bitrate || 0)
        + Number(entry.vwidth || entry.width || 0) * Number(entry.vheight || entry.height || 0);
      if (!best || score > best.score) best = { token: token.trim(), score };
    }
    return best?.token || "";
  }

  function findKeySeedDeep(value, depth = 0) {
    if (depth > 10 || value == null) return "";
    if (typeof value === "string") {
      let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i);
      if (match) return decodeURIComponent(match[1]);
      match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i);
      return match ? decodeURIComponent(match[1]) : "";
    }
    if (typeof value !== "object") return "";
    if (typeof value.key_seed === "string" && value.key_seed.trim()) return value.key_seed.trim();
    for (const item of Object.values(value)) {
      const result = findKeySeedDeep(item, depth + 1);
      if (result) return result;
    }
    return "";
  }

  async function decodeMainUrl(token, keySeed = "") {
    if (isHttpUrl(token)) return token;
    const plain = tryDecodeBase64Url(token);
    if (plain) return plain;
    return token.startsWith("qAAB") && keySeed ? decodeQaabToken(token, keySeed) : "";
  }

  function tryDecodeBase64Url(token) {
    const bytes = base64DecodeLoose(token);
    if (!bytes) return "";
    const text = asciiUrlFromBytes(bytes);
    return isHttpUrl(text) ? text : "";
  }

  function base64DecodeLoose(text) {
    const input = String(text || "").trim();
    const variants = [
      input,
      input.replace(/[$@#]/g, (char) => ({ "$": "_", "@": "/", "#": "." })[char]),
      input.replace(/[$@#]/g, (char) => ({ "$": "+", "@": "/", "#": "=" })[char])
    ];
    for (const candidate of new Set(variants)) {
      if (!candidate) continue;
      try {
        const normalized = padBase64(candidate).replace(/-/g, "+").replace(/_/g, "/");
        const binary = atob(normalized);
        return Uint8Array.from(binary, (char) => char.charCodeAt(0));
      } catch {
        // Try the next encoding variant.
      }
    }
    return null;
  }

  function padBase64(text) {
    return text + "=".repeat((4 - (text.length % 4)) % 4);
  }

  function asciiUrlFromBytes(bytes) {
    if (!bytes?.length) return "";
    for (const byte of bytes) {
      if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) return "";
    }
    return new TextDecoder().decode(bytes);
  }

  async function decodeQaabToken(token, keySeed) {
    const data = base64DecodeLoose(token);
    const seed = base64DecodeLoose(keySeed);
    if (!data || !seed) return "";
    const digest1 = await crypto.subtle.digest("SHA-512", seed.slice(0, 32));
    const digest2 = new Uint8Array(await crypto.subtle.digest(
      "SHA-512",
      concatBytes(new Uint8Array(digest1), hexToBytes(QAAB_SALT_HEX))
    ));
    const key = digest2.slice(0, 16);
    const iv = digest2.slice(16, 32);
    const attempts = [];
    if (data.length >= 4 && data[0] === 0xa8 && data[1] === 0 && data[2] === 1 && data[3] === 0) {
      attempts.push({ payload: data.slice(4), key, iv }, { payload: data.slice(4), key: iv, iv: key });
      if (data.length > 36) attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) });
    } else {
      attempts.push({ payload: data, key, iv });
    }
    for (const attempt of attempts) {
      const url = await decryptAesCbcUrl(attempt.payload, attempt.key, attempt.iv);
      if (url) return url;
    }
    return "";
  }

  async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
    if (!payload.length || payload.length % 16 !== 0) return "";
    try {
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CBC", false, ["decrypt"]);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: ivBytes }, key, payload));
      const direct = asciiUrlFromBytes(plain);
      if (isHttpUrl(direct)) return direct;
      const stripped = stripPkcs7(plain);
      const url = asciiUrlFromBytes(stripped);
      return isHttpUrl(url) ? url : "";
    } catch {
      return "";
    }
  }

  function stripPkcs7(bytes) {
    const pad = bytes[bytes.length - 1];
    if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
    for (let index = bytes.length - pad; index < bytes.length; index += 1) {
      if (bytes[index] !== pad) return bytes;
    }
    return bytes.slice(0, bytes.length - pad);
  }

  function hexToBytes(hex) {
    return Uint8Array.from({ length: hex.length / 2 }, (_, index) => parseInt(hex.slice(index * 2, index * 2 + 2), 16));
  }

  function concatBytes(first, second) {
    const bytes = new Uint8Array(first.length + second.length);
    bytes.set(first);
    bytes.set(second, first.length);
    return bytes;
  }

  function findValuesByKey(value, targetKey) {
    const values = [];
    walkJsonAndStrings(value, (node) => {
      if (node && !Array.isArray(node) && Object.prototype.hasOwnProperty.call(node, targetKey)) {
        values.push(node[targetKey]);
      }
    });
    return values;
  }

  function walkJsonAndStrings(value, visitor, seen = new Set()) {
    if (value == null) return;
    if (typeof value === "string") {
      const parsed = parseJsonString(value);
      if (parsed !== null) walkJsonAndStrings(parsed, visitor, seen);
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    visitor(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      walkJsonAndStrings(child, visitor, seen);
    }
  }

  function parseJsonString(text) {
    const trimmed = text.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function decodeJsonEscapedFragment(value) {
    let text = value;
    for (let index = 0; index < 3; index += 1) {
      try {
        const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`);
        if (decoded === text) break;
        text = decoded;
      } catch {
        break;
      }
    }
    return text.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  }

  function addItem(items, seen, type, url, clean) {
    if (!isHttpUrl(url) || seen.has(url)) return;
    seen.add(url);
    items.push({ type, url, clean: Boolean(clean) });
  }

  function isHttpUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url);
  }
})();
