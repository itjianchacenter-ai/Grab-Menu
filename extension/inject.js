// Runs in the page's MAIN world via manifest content_scripts (world: "MAIN").
// Hooks fetch / XHR / WebSocket so we see every response Grab's app receives.
(function () {
  "use strict";
  const TAG = "%c[grab-menu]";
  const STYLE = "color:#059669;font-weight:bold";
  console.log(TAG, STYLE, "🟢 inject.js v0.1.4 LOADED (MAIN world) at", document.readyState);

  let captureCount = 0;
  const POST = (payload) => window.postMessage({ __grabMenu: true, ...payload }, "*");

  const isInteresting = (text) => {
    if (!text || text.length < 200) return false;
    const t = text.trimStart().slice(0, 1);
    if (t !== "{" && t !== "[") return false;
    return /\b(merchant|menu|item|categor|product|price)\b/i.test(text);
  };

  const reportCapture = (url, text) => {
    if (!isInteresting(text)) return;
    captureCount++;
    console.log(TAG, STYLE, `capture #${captureCount}`, url.slice(0, 80), `${text.length}b`);
    POST({ url, body: text, ts: Date.now() });
  };

  // ---- fetch ----
  const _fetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await _fetch.apply(this, args);
    try {
      const url = (typeof args[0] === "string" ? args[0] : args[0]?.url) || "";
      res
        .clone()
        .text()
        .then((t) => reportCapture(url, t))
        .catch(() => {});
    } catch (_) {}
    return res;
  };

  // ---- XMLHttpRequest ----
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__grabUrl = url;
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", () => {
      try {
        const url = this.__grabUrl || this.responseURL || "";
        reportCapture(url, this.responseText || "");
      } catch (_) {}
    });
    return _send.apply(this, arguments);
  };

  // ---- WebSocket (some Grab pages stream data) ----
  const OrigWS = window.WebSocket;
  if (OrigWS) {
    window.WebSocket = function (url, protocols) {
      const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
      ws.addEventListener("message", (ev) => {
        try {
          const text = typeof ev.data === "string" ? ev.data : "";
          reportCapture(`[ws] ${url}`, text);
        } catch (_) {}
      });
      return ws;
    };
    window.WebSocket.prototype = OrigWS.prototype;
  }

  // ---- Window state probe ----
  // Some apps put data in window globals — probe after load.
  const probeWindowState = () => {
    const candidates = [
      "__INITIAL_STATE__",
      "__REDUX_STATE__",
      "__APOLLO_STATE__",
      "__NEXT_DATA__",
      "__PRELOADED_STATE__",
      "__data",
    ];
    for (const k of candidates) {
      const v = window[k];
      if (v && typeof v === "object") {
        try {
          const text = JSON.stringify(v);
          console.log(TAG, STYLE, `window.${k} found (${text.length}b)`);
          reportCapture(`window.${k}`, text);
        } catch (_) {}
      }
    }
  };
  if (document.readyState === "complete") probeWindowState();
  else window.addEventListener("load", () => setTimeout(probeWindowState, 1500));

  // Periodic state probe (catches lazy-loaded state)
  let probes = 0;
  const intv = setInterval(() => {
    probes++;
    probeWindowState();
    if (probes > 6) clearInterval(intv);
  }, 2000);
})();
