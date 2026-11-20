// ============================= inject websocket code ============================
(function () {
  const STORAGE_KEY = "ufs_rvdfm_all_msgs";

  const inject_ws_script = document.createElement("script");
  inject_ws_script.src = chrome.runtime.getURL("./inject_websocket.js");
  inject_ws_script.onload = function () {
    if (this.parentNode) this.parentNode.removeChild(this);
  };
  const doc = document.head || document.documentElement || document.body;
  if (doc) {
    doc.appendChild(inject_ws_script);
  }

  // Đồng bộ dữ liệu tin nhắn đã lưu sang chrome.storage.local cho Popup
  window.addEventListener("ufs_rvdfm_to_ext_storage", (e) => {
    try {
      if (!chrome?.storage?.local || !e?.detail) return;
      const incoming =
        typeof e.detail === "string" ? JSON.parse(e.detail) : e.detail;
      if (!incoming || typeof incoming !== "object") return;

      chrome.storage.local.get([STORAGE_KEY], (res) => {
        if (chrome.runtime.lastError) return;
        const current =
          res?.[STORAGE_KEY] && typeof res[STORAGE_KEY] === "object"
            ? res[STORAGE_KEY]
            : {};
        const merged = Object.assign({}, current, incoming);
        const keys = Object.keys(merged);
        if (keys.length > 3000) {
          keys
            .sort(
              (a, b) =>
                (merged[a]?.saved_time || 0) - (merged[b]?.saved_time || 0)
            )
            .slice(0, keys.length - 2500)
            .forEach((k) => delete merged[k]);
        }
        chrome.storage.local.set({ [STORAGE_KEY]: merged });
      });
    } catch (err) {}
  });
})();
