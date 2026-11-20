(function () {
  const STORAGE_KEY = "ufs_rvdfm_all_msgs";
  const savedCountEl = document.getElementById("saved-count");
  const unsentCountEl = document.getElementById("unsent-count");
  const msgListEl = document.getElementById("msg-list");
  const searchInput = document.getElementById("search-input");
  const filterType = document.getElementById("filter-type");
  const clearBtn = document.getElementById("clear-btn");

  let allMessages = {};

  function formatTime(ts) {
    if (!ts) return "";
    try {
      return new Date(ts).toLocaleString("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        day: "2-digit",
        month: "2-digit",
      });
    } catch (e) {
      return "";
    }
  }

  function renderList() {
    const entries = Object.entries(allMessages)
      .filter(([k, v]) => v && typeof v === "object" && !k.startsWith("otid_"))
      .sort((a, b) => (b[1].saved_time || 0) - (a[1].saved_time || 0));

    const unsentEntries = entries.filter(([, v]) => v.is_unsent);
    savedCountEl.textContent = String(entries.length);
    unsentCountEl.textContent = String(unsentEntries.length);

    const query = (searchInput.value || "").trim().toLowerCase();
    const onlyUnsent = filterType.value === "unsent";

    const filtered = entries
      .filter(([, v]) => {
        if (onlyUnsent && !v.is_unsent) return false;
        if (query) {
          const text = `${v.text || ""} ${v.data || ""} ${v.type || ""}`.toLowerCase();
          return text.includes(query);
        }
        return true;
      })
      .slice(0, 80);

    msgListEl.textContent = "";

    if (filtered.length === 0) {
      const emptyDiv = document.createElement("div");
      emptyDiv.className = "empty";
      emptyDiv.textContent = onlyUnsent
        ? "Chưa phát hiện tin nhắn thu hồi nào."
        : "Không tìm thấy tin nhắn nào.";
      msgListEl.appendChild(emptyDiv);
      return;
    }

    for (const [, msg] of filtered) {
      const item = document.createElement("div");
      item.className = "msg-item" + (msg.is_unsent ? " unsent" : "");

      const meta = document.createElement("div");
      meta.className = "msg-meta";

      const typeSpan = document.createElement("span");
      typeSpan.className = "msg-type";
      typeSpan.textContent =
        (msg.is_unsent ? "🔓 [Đã thu hồi] " : "") +
        `Loại: ${msg.type || "chữ"}`;

      const timeSpan = document.createElement("span");
      timeSpan.textContent = formatTime(msg.unsent_time || msg.saved_time);

      meta.appendChild(typeSpan);
      meta.appendChild(timeSpan);
      item.appendChild(meta);

      const body = document.createElement("div");
      body.className = "msg-body";

      const displayTxt = msg.text || (!msg.attachments?.length ? msg.data : "");
      if (displayTxt) {
        const txtNode = document.createElement("div");
        txtNode.textContent = displayTxt;
        body.appendChild(txtNode);
      }

      if (Array.isArray(msg.attachments)) {
        for (const att of msg.attachments) {
          if (!att?.url) continue;
          const link = document.createElement("a");
          link.href = att.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = "↗ Mở media/link trong tab mới";
          body.appendChild(link);

          if (
            att.type === "ảnh" ||
            att.type === "gif" ||
            att.type === "sticker"
          ) {
            const img = document.createElement("img");
            img.src = att.url;
            img.alt = att.type;
            body.appendChild(img);
          }
        }
      }

      item.appendChild(body);
      msgListEl.appendChild(item);
    }
  }

  function loadStorage() {
    if (!chrome?.storage?.local) return;
    chrome.storage.local.get([STORAGE_KEY], (res) => {
      allMessages =
        res?.[STORAGE_KEY] && typeof res[STORAGE_KEY] === "object"
          ? res[STORAGE_KEY]
          : {};
      renderList();
    });
  }

  searchInput.addEventListener("input", renderList);
  filterType.addEventListener("change", renderList);

  clearBtn.addEventListener("click", () => {
    if (!confirm("Bạn có chắc muốn xóa toàn bộ tin nhắn đã lưu?")) return;
    allMessages = {};
    if (chrome?.storage?.local) {
      chrome.storage.local.set({ [STORAGE_KEY]: {} }, renderList);
    }
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) {
        allMessages = changes[STORAGE_KEY].newValue || {};
        renderList();
      }
    });
  }

  loadStorage();
})();
