(function () {
  const CURRENT_VERSION = "0.0.6";
  const STORAGE_KEY = "ufs_rvdfm_all_msgs";
  const MAX_SAVED_MSGS = 3000;
  // Giới hạn an toàn mỗi phần tin nhắn (tránh lỗi "Couldn't send" của Facebook khi tin nhắn > 20.000 ký tự / > 16KB UTF-8)
  const MAX_SAFE_MSG_CHARS = 7500;

  const UfsChatType = {
    text: "chữ",
    image: "ảnh",
    video: "video",
    gif: "gif",
    audioclip: "âm thanh",
    sticker: "sticker",
    share_location: "vị trí",
    realtime_location: "vị trí thực",
    link: "link",
    reply: "trả lời",
    add_reaction: "react",
    remove_reaction: "gỡ react",
    attachment: "đính kèm",
    sound: "âm thanh",
    pending: "pending",
    user_data: "user_data",
    delete_msg: "delete_msg",
  };
  window.UfsChatType = UfsChatType;

  const isMsgIdStr = (str) =>
    typeof str === "string" && str.startsWith("mid.$");

  // Chuẩn hóa dữ liệu tin nhắn (tương thích ngược với dữ liệu cũ trong localStorage)
  function normalizeEntry(entry) {
    if (!entry || typeof entry !== "object") return null;

    let text = typeof entry.text === "string" ? entry.text : "";
    let reply_to = typeof entry.reply_to === "string" ? entry.reply_to : null;
    let type = typeof entry.type === "string" ? entry.type : "";
    let attachments = Array.isArray(entry.attachments)
      ? entry.attachments.filter((a) => a && typeof a.url === "string")
      : [];

    if (entry.data && typeof entry.data === "object") {
      if (typeof entry.data.content === "string" && !text) {
        text = entry.data.content;
      }
      if (typeof entry.data.reply_to === "string" && !reply_to) {
        reply_to = entry.data.reply_to;
      }
    } else if (
      typeof entry.data === "string" &&
      !text &&
      attachments.length === 0
    ) {
      const rawData = entry.data.trim();
      if (
        rawData &&
        rawData !== "undefined" &&
        rawData !== "null" &&
        rawData !== "[object Object]"
      ) {
        const isMediaType =
          type === UfsChatType.image ||
          type === UfsChatType.video ||
          type === UfsChatType.gif ||
          type === UfsChatType.sticker ||
          type === UfsChatType.audioclip ||
          type === UfsChatType.sound ||
          type === UfsChatType.attachment;

        if (isMediaType && /^https?:\/\//i.test(rawData)) {
          attachments.push({
            type: type || UfsChatType.attachment,
            url: rawData,
          });
        } else {
          text = entry.data;
        }
      }
    }

    if (!type || type === "undefined") {
      if (reply_to) {
        type = UfsChatType.reply;
      } else if (attachments.length > 0) {
        type = attachments[0].type || UfsChatType.attachment;
      } else if (/^https?:\/\//i.test(text.trim())) {
        type = UfsChatType.link;
      } else {
        type = UfsChatType.text;
      }
    }

    const parts = [];
    if (text) parts.push(text);
    for (const att of attachments) {
      if (att?.url && !parts.includes(att.url)) {
        parts.push(att.url);
      }
    }
    const dataStr = parts.join("\n").trim();
    if (!dataStr && attachments.length === 0) return null;

    const normalized = {
      type,
      data: dataStr,
      saved_time: entry.saved_time || Date.now(),
    };
    if (text) normalized.text = text;
    if (attachments.length > 0) normalized.attachments = attachments;
    if (reply_to) normalized.reply_to = reply_to;
    if (entry.is_unsent) normalized.is_unsent = true;
    if (entry.unsent_time) normalized.unsent_time = entry.unsent_time;

    return normalized;
  }

  if (!window.ufs_rvdfm_all_msgs) {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      window.ufs_rvdfm_all_msgs =
        raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      window.ufs_rvdfm_all_msgs = {};
    }
  }

  let saveTimer = null;
  let pendingSyncBatch = {};

  function scheduleSave(immediate = false) {
    const doSave = () => {
      saveTimer = null;
      try {
        const all = window.ufs_rvdfm_all_msgs;
        const keys = Object.keys(all);
        if (keys.length > MAX_SAVED_MSGS) {
          keys
            .sort(
              (a, b) => (all[a]?.saved_time || 0) - (all[b]?.saved_time || 0)
            )
            .slice(0, keys.length - 2500)
            .forEach((k) => delete all[k]);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(all));

        if (Object.keys(pendingSyncBatch).length > 0) {
          const batch = pendingSyncBatch;
          pendingSyncBatch = {};
          window.dispatchEvent(
            new CustomEvent("ufs_rvdfm_to_ext_storage", {
              detail: JSON.stringify(batch),
            })
          );
        }
      } catch (e) {}
    };

    if (immediate) {
      if (saveTimer) clearTimeout(saveTimer);
      doSave();
    } else if (!saveTimer) {
      saveTimer = setTimeout(doSave, 500);
    }
  }

  function detectAttachmentType(hintStr, urlStr) {
    const s = `${hintStr || ""} ${urlStr || ""}`.toLowerCase();
    if (s.includes("gif") || /\.gif(\?|$)/i.test(s)) return UfsChatType.gif;
    if (
      s.includes("audioclip") ||
      s.includes("audio") ||
      /\.(mp3|wav|ogg|m4a|aac)(\?|$)/i.test(s)
    ) {
      return UfsChatType.audioclip;
    }
    if (s.includes("video") || /\.(mp4|webm|mov)(\?|$)/i.test(s)) {
      return UfsChatType.video;
    }
    if (s.includes("sticker")) {
      return UfsChatType.sticker;
    }
    if (
      s.includes("image") ||
      s.includes("photo") ||
      /\.(jpg|jpeg|png|webp|bmp|heic)(\?|$)/i.test(s)
    ) {
      return UfsChatType.image;
    }
    return UfsChatType.attachment;
  }

  // Đệ quy tìm các mảng lệnh [5, "procedureName", ...] trong payload của WebSocket
  function findCommandArrays(obj) {
    const results = [];
    if (!obj || typeof obj !== "object") return results;

    for (const key in obj) {
      const val = obj[key];
      if (Array.isArray(val) && val[0] === 5 && typeof val[1] === "string") {
        results.push({
          raw: val,
          flat: val.filter((i) => !Array.isArray(i)),
        });
      } else if (val && typeof val === "object") {
        results.push(...findCommandArrays(val));
      }
    }
    return results;
  }

  function upsertSavedMessage(msgId, newItem) {
    if (!msgId || !isMsgIdStr(msgId)) return;
    const existing = normalizeEntry(window.ufs_rvdfm_all_msgs[msgId]);
    let merged;

    if (existing) {
      const combinedAttachments = [...(existing.attachments || [])];
      if (Array.isArray(newItem.attachments)) {
        for (const att of newItem.attachments) {
          if (
            att?.url &&
            !combinedAttachments.some((a) => a.url === att.url)
          ) {
            combinedAttachments.push(att);
          }
        }
      }
      const newText =
        typeof newItem.text === "string" &&
        newItem.text.trim() &&
        !isMsgIdStr(newItem.text)
          ? newItem.text
          : existing.text || "";
      const newReplyTo = newItem.reply_to || existing.reply_to || null;
      let primaryType = existing.type;
      if (newReplyTo) {
        primaryType = UfsChatType.reply;
      } else if (
        newItem.type &&
        newItem.type !== UfsChatType.link &&
        (!primaryType || primaryType === UfsChatType.text)
      ) {
        primaryType = newItem.type;
      }

      merged = normalizeEntry({
        ...existing,
        type: primaryType || newItem.type || UfsChatType.text,
        text: newText,
        attachments: combinedAttachments,
        reply_to: newReplyTo,
        saved_time: existing.saved_time || Date.now(),
      });
    } else {
      merged = normalizeEntry({
        ...newItem,
        saved_time: Date.now(),
      });
    }

    if (merged) {
      window.ufs_rvdfm_all_msgs[msgId] = merged;
      pendingSyncBatch[msgId] = merged;
      scheduleSave(false);
    }
  }

  function processPayload(payload) {
    const allCmds = findCommandArrays(payload);
    for (const { raw, flat } of allCmds) {
      const cmd = flat[1];
      const allMsgIds = flat.filter(
        (i) => typeof i === "string" && isMsgIdStr(i)
      );
      const msg_id = allMsgIds[0];
      if (!msg_id) continue;

      if (cmd === "insertMessage" || cmd === "upsertMessage") {
        if (
          typeof raw[2] === "string" &&
          !isMsgIdStr(raw[2]) &&
          raw[2].length > 0
        ) {
          const replyTo = allMsgIds.length > 1 ? allMsgIds[1] : null;
          upsertSavedMessage(msg_id, {
            type: replyTo ? UfsChatType.reply : UfsChatType.text,
            text: raw[2],
            reply_to: replyTo,
          });
        }
      } else if (cmd === "insertStickerAttachment") {
        const urls = flat.filter(
          (i) => typeof i === "string" && /^https?:\/\//i.test(i)
        );
        const stickerUrl = urls[0] || flat[2];
        if (typeof stickerUrl === "string" && stickerUrl) {
          upsertSavedMessage(msg_id, {
            type: UfsChatType.sticker,
            attachments: [{ type: UfsChatType.sticker, url: stickerUrl }],
          });
        }
      } else if (cmd === "insertBlobAttachment") {
        const urls = flat.filter(
          (i) => typeof i === "string" && /^https?:\/\//i.test(i)
        );
        const mediaUrl = urls[1] || urls[0] || flat[4] || flat[2];
        if (typeof mediaUrl === "string" && mediaUrl) {
          const hint = flat
            .filter((i) => typeof i === "string" && !/^https?:\/\//i.test(i))
            .join(" ");
          const mediaType = detectAttachmentType(hint, mediaUrl);
          upsertSavedMessage(msg_id, {
            type: mediaType,
            attachments: [{ type: mediaType, url: mediaUrl }],
          });
        }
      } else if (cmd === "insertAttachmentCta") {
        if (flat[5] === "xma_live_location_sharing") {
          if (flat[7]) {
            upsertSavedMessage(msg_id, {
              type: UfsChatType.share_location,
              text: "https://www.google.com/maps/search/" + flat[7],
            });
          } else {
            upsertSavedMessage(msg_id, {
              type: UfsChatType.realtime_location,
              text: String(flat[6] || ""),
            });
          }
        } else if (flat[5] === "xma_web_url" && flat[6]) {
          upsertSavedMessage(msg_id, {
            type: UfsChatType.link,
            attachments: [{ type: UfsChatType.link, url: String(flat[6]) }],
          });
        }
      } else if (cmd === "deleteThenInsertMessage") {
        if (window.ufs_rvdfm_all_msgs[msg_id]) {
          window.ufs_rvdfm_all_msgs[msg_id].is_unsent = true;
          window.ufs_rvdfm_all_msgs[msg_id].unsent_time = Date.now();
          pendingSyncBatch[msg_id] = window.ufs_rvdfm_all_msgs[msg_id];
          scheduleSave(false);
        }
      }
    }
  }

  function parseWsString(utf8_str) {
    try {
      let jsonStart = utf8_str.indexOf('{"');
      if (jsonStart === -1) jsonStart = utf8_str.indexOf("{");
      if (jsonStart === -1) return;

      let dataStr = utf8_str.slice(jsonStart);
      const lastBrace = dataStr.lastIndexOf("}");
      if (lastBrace !== -1) dataStr = dataStr.slice(0, lastBrace + 1);

      const data = JSON.parse(dataStr);
      const payload =
        typeof data?.payload === "string"
          ? JSON.parse(data.payload)
          : data?.payload;

      if (payload) {
        processPayload(payload);
      }
    } catch (e) {}
  }

  // ========================== LẮNG NGHE WEBSOCKET THỤ ĐỘNG ==========================
  if (!window.__ufs_rvdfm_ws_hooked) {
    window.__ufs_rvdfm_ws_hooked = true;
    window.addEventListener("beforeunload", () => scheduleSave(true));

    const textDecoder = new TextDecoder("utf-8");
    const hookedSockets = new WeakSet();
    const origAddEventListener = WebSocket.prototype.addEventListener;

    function onWsMessage(achunk) {
      const rawData = achunk?.data;
      if (!rawData) return;

      setTimeout(() => {
        try {
          if (
            rawData instanceof ArrayBuffer ||
            ArrayBuffer.isView(rawData)
          ) {
            const utf8_str = textDecoder.decode(rawData);
            if (utf8_str.includes("mid.$")) {
              parseWsString(utf8_str);
            }
          } else if (typeof rawData === "string") {
            if (rawData.includes("mid.$")) {
              parseWsString(rawData);
            }
          }
        } catch (e) {}
      }, 0);
    }

    function ensureSocketHooked(ws) {
      if (!ws || !(ws instanceof WebSocket) || hookedSockets.has(ws)) return;
      hookedSockets.add(ws);
      origAddEventListener.call(ws, "message", onWsMessage);
    }

    WebSocket.prototype.addEventListener = function (type, listener, options) {
      try {
        ensureSocketHooked(this);
      } catch (e) {}
      return origAddEventListener.apply(this, arguments);
    };

    const origSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      try {
        ensureSocketHooked(this);
      } catch (e) {}
      return origSend.apply(this, arguments);
    };

    const onMessageDesc = Object.getOwnPropertyDescriptor(
      WebSocket.prototype,
      "onmessage"
    );
    if (onMessageDesc && typeof onMessageDesc.set === "function") {
      Object.defineProperty(WebSocket.prototype, "onmessage", {
        ...onMessageDesc,
        set(fn) {
          try {
            ensureSocketHooked(this);
          } catch (e) {}
          return onMessageDesc.set.call(this, fn);
        },
      });
    }
  }

  // ========================== TỰ ĐỘNG CHIA NHỎ TIN NHẮN DÀI (FIX LỖI "COULDN'T SEND") ==========================
  // Facebook Messenger giới hạn độ dài mỗi tin nhắn (~20.000 ký tự / ~16KB UTF-8).
  // Khi gửi tin nhắn quá dài (như đề cương 20.204 ký tự), server sẽ từ chối và báo "Couldn't send".
  // Module này tự động tách tin nhắn dài tại các đoạn xuống dòng (\n\n hoặc \n) và gửi lần lượt từng phần.
  function splitLongMessage(text, maxLen = MAX_SAFE_MSG_CHARS) {
    const normalized = String(text || "")
      .replace(/\r\n/g, "\n")
      .trim();
    if (!normalized) return [];
    if (normalized.length <= maxLen) return [normalized];

    const chunks = [];
    let remaining = normalized;

    while (remaining.length > maxLen) {
      const windowSlice = remaining.slice(0, maxLen);
      let splitIdx = -1;

      // Ưu tiên tách trước các đề mục / câu hỏi mới (BÀI, PHẦN, Câu, I., II., III.)
      const sectionRegex = /\n+(?=(?:[IVX]+\.\s|BÀI\s+\d+|PHẦN\s|Câu\s+\d+))/g;
      let match;
      while ((match = sectionRegex.exec(windowSlice)) !== null) {
        if (match.index >= Math.floor(maxLen * 0.4)) {
          splitIdx = match.index;
        }
      }

      if (splitIdx === -1) {
        splitIdx = remaining.lastIndexOf("\n\n", maxLen);
      }
      if (splitIdx < Math.floor(maxLen * 0.35)) {
        splitIdx = remaining.lastIndexOf("\n", maxLen);
      }
      if (splitIdx < Math.floor(maxLen * 0.25)) {
        splitIdx = remaining.lastIndexOf(" ", maxLen);
      }
      if (splitIdx <= 0) {
        splitIdx = maxLen;
      }
      const piece = remaining.slice(0, splitIdx).trim();
      if (piece) chunks.push(piece);
      remaining = remaining.slice(splitIdx).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
  }

  function getLexicalModule() {
    try {
      if (typeof window.require === "function") {
        return window.require("Lexical");
      }
    } catch (e) {}
    return null;
  }

  function getActiveTextbox() {
    const active = document.activeElement;
    if (
      active &&
      active.getAttribute?.("role") === "textbox" &&
      active.getAttribute?.("contenteditable") === "true"
    ) {
      return active;
    }
    return (
      document.querySelector('[role="textbox"][data-lexical-editor="true"]') ||
      document.querySelector('[role="textbox"][contenteditable="true"]')
    );
  }

  function getComposerText(tb) {
    if (!tb) return "";
    try {
      const editor = tb.__lexicalEditor;
      const Lexical = getLexicalModule();
      if (editor && Lexical && typeof Lexical.$getRoot === "function") {
        let text = "";
        editor.getEditorState().read(() => {
          text = Lexical.$getRoot().getTextContent();
        });
        if (typeof text === "string" && text.length > 0) {
          return text;
        }
      }
    } catch (e) {}
    if (
      typeof tb.__lexicalTextContent === "string" &&
      tb.__lexicalTextContent.length > 0
    ) {
      return tb.__lexicalTextContent;
    }
    return tb.innerText || tb.textContent || "";
  }

  function setComposerText(tb, text) {
    if (!tb) return false;
    const editor = tb.__lexicalEditor;
    const Lexical = getLexicalModule();
    if (editor && Lexical && typeof Lexical.$getRoot === "function") {
      try {
        editor.update(
          () => {
            const root = Lexical.$getRoot();
            root.clear();
            if (text && text.length > 0) {
              const p = Lexical.$createParagraphNode();
              const lines = String(text).split(/\r?\n/);
              for (let i = 0; i < lines.length; i++) {
                if (i > 0 && typeof Lexical.$createLineBreakNode === "function") {
                  p.append(Lexical.$createLineBreakNode());
                }
                if (lines[i].length > 0) {
                  p.append(Lexical.$createTextNode(lines[i]));
                }
              }
              root.append(p);
              if (typeof root.selectEnd === "function") {
                root.selectEnd();
              }
            }
          },
          { discrete: true }
        );
        return true;
      } catch (e) {}
    }
    return false;
  }

  function triggerNativeSendOnTextbox(tb) {
    if (!tb) return;
    tb.focus();
    const editor = tb.__lexicalEditor;
    const Lexical = getLexicalModule();

    const enterEv = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(enterEv, "__ufs_synthetic", {
      value: true,
      configurable: true,
    });

    if (editor && Lexical && Lexical.KEY_ENTER_COMMAND) {
      try {
        const handled = editor.dispatchCommand(
          Lexical.KEY_ENTER_COMMAND,
          enterEv
        );
        if (handled) return;
      } catch (e) {}
    }

    tb.dispatchEvent(enterEv);
  }

  let isSendingChunks = false;

  async function sendLongTextInChunks(fullText, targetTb = null) {
    if (isSendingChunks) return false;
    const tb = targetTb || getActiveTextbox();
    if (!tb) return false;

    const chunks = splitLongMessage(fullText, MAX_SAFE_MSG_CHARS);
    if (chunks.length === 0) return false;

    isSendingChunks = true;
    try {
      for (let i = 0; i < chunks.length; i++) {
        const currentTb = getActiveTextbox() || tb;
        setComposerText(currentTb, chunks[i]);
        await new Promise((r) => setTimeout(r, 70));
        triggerNativeSendOnTextbox(currentTb);
        await new Promise((r) => setTimeout(r, 420));
      }
      return true;
    } finally {
      isSendingChunks = false;
    }
  }

  window.__ufs_sendLongText = sendLongTextInChunks;
  window.__ufs_splitLongMessage = splitLongMessage;

  if (!window.__ufs_rvdfm_splitter_v6) {
    window.__ufs_rvdfm_splitter_v6 = true;

    window.addEventListener(
      "keydown",
      (e) => {
        if (e.__ufs_synthetic || isSendingChunks) return;
        if (
          e.key !== "Enter" ||
          e.shiftKey ||
          e.ctrlKey ||
          e.altKey ||
          e.metaKey ||
          e.isComposing
        ) {
          return;
        }
        const tb =
          e.target?.closest?.('[role="textbox"]') || getActiveTextbox();
        if (!tb) return;

        const currentText = getComposerText(tb).trim();
        if (currentText.length > MAX_SAFE_MSG_CHARS) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          sendLongTextInChunks(currentText, tb);
        }
      },
      true
    );

    window.addEventListener(
      "click",
      (e) => {
        if (isSendingChunks) return;
        const btn = e.target?.closest?.('[role="button"], button');
        if (!btn) return;
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (
          aria.includes("press enter to send") ||
          aria.includes("nhấn enter để gửi")
        ) {
          const tb = getActiveTextbox();
          if (!tb) return;
          const currentText = getComposerText(tb).trim();
          if (currentText.length > MAX_SAFE_MSG_CHARS) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            sendLongTextInChunks(currentText, tb);
          }
        }
      },
      true
    );
  }

  // ========================== HIỂN THỊ TIN NHẮN THU HỒI ==========================
  let cachedReact = null;
  function getReactCreateElement() {
    if (!cachedReact) {
      try {
        if (typeof window.require === "function") {
          const R = window.require("react");
          if (R && typeof R.createElement === "function") {
            cachedReact = R;
          } else if (
            R?.default &&
            typeof R.default.createElement === "function"
          ) {
            cachedReact = R.default;
          }
        }
      } catch (e) {}
    }
    return cachedReact && typeof cachedReact.createElement === "function"
      ? cachedReact.createElement.bind(cachedReact)
      : null;
  }

  function renderTextWithLinks(h, text, outgoing) {
    if (!text) return null;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const parts = String(text).split(urlRegex);
    const linkColor = outgoing ? "#ffeb3b" : "#4599ff";

    return parts.map((part, idx) => {
      if (/^https?:\/\/[^\s]+$/i.test(part)) {
        return h(
          "a",
          {
            key: `lnk_${idx}`,
            href: part,
            target: "_blank",
            rel: "noopener noreferrer",
            onClick: (e) => e.stopPropagation(),
            style: {
              color: linkColor,
              textDecoration: "underline",
              wordBreak: "break-all",
            },
          },
          part
        );
      }
      return part;
    });
  }

  function buildRevealedReactElement(h, props, savedMsg) {
    const outgoing = Boolean(props?.outgoing);
    const bg = outgoing
      ? "var(--chat-outgoing-message-bubble-background-color, #0084ff)"
      : "var(--chat-incoming-message-bubble-background-color, var(--wash, #303030))";
    const fg = outgoing ? "#ffffff" : "var(--primary-text, #e4e6eb)";
    const linkColor = outgoing ? "#ffeb3b" : "#4599ff";

    const children = [];
    const headerTitle = savedMsg
      ? `[Tin thu hồi - ${savedMsg.type || UfsChatType.text}]:`
      : "[Tin thu hồi]:";

    children.push(
      h(
        "div",
        {
          key: "rv_hdr",
          style: {
            fontWeight: "600",
            fontSize: "12px",
            opacity: 0.92,
            marginBottom: "4px",
            paddingBottom: "3px",
            borderBottom: outgoing
              ? "1px solid rgba(255, 255, 255, 0.25)"
              : "1px solid rgba(128, 128, 128, 0.25)",
          },
        },
        headerTitle
      )
    );

    if (!savedMsg) {
      children.push(
        h(
          "div",
          {
            key: "rv_empty",
            style: {
              fontStyle: "italic",
              opacity: 0.85,
              fontSize: "14px",
            },
          },
          "-Không có dữ liệu-"
        )
      );
    } else {
      if (savedMsg.reply_to) {
        const repliedOrigin = normalizeEntry(
          window.ufs_rvdfm_all_msgs[savedMsg.reply_to]
        );
        const repliedPreview = repliedOrigin
          ? repliedOrigin.text || repliedOrigin.data
          : "Tin nhắn trước đó";
        children.push(
          h(
            "div",
            {
              key: "rv_reply",
              style: {
                fontSize: "12px",
                padding: "4px 8px",
                marginBottom: "6px",
                borderRadius: "8px",
                backgroundColor: "rgba(0, 0, 0, 0.18)",
                borderLeft: "3px solid rgba(255, 255, 255, 0.6)",
                opacity: 0.9,
              },
            },
            `↩ Trả lời: ${repliedPreview}`
          )
        );
      }

      const attachments = Array.isArray(savedMsg.attachments)
        ? savedMsg.attachments
        : [];
      const attachmentUrls = new Set(attachments.map((a) => a.url));
      const textToDisplay =
        savedMsg.text || (!attachments.length ? savedMsg.data : "");

      if (textToDisplay && !attachmentUrls.has(textToDisplay.trim())) {
        children.push(
          h(
            "div",
            {
              key: "rv_txt",
              style: {
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: "15px",
                lineHeight: "1.35",
              },
            },
            ...renderTextWithLinks(h, textToDisplay, outgoing)
          )
        );
      }

      attachments.forEach((att, idx) => {
        if (!att?.url) return;
        const attType = att.type || detectAttachmentType("", att.url);

        if (
          attType === UfsChatType.image ||
          attType === UfsChatType.gif ||
          attType === UfsChatType.sticker
        ) {
          children.push(
            h(
              "div",
              { key: `rv_att_${idx}`, style: { marginTop: "6px" } },
              h(
                "a",
                {
                  href: att.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: (e) => e.stopPropagation(),
                  style: { display: "block" },
                },
                h("img", {
                  src: att.url,
                  alt: attType,
                  style: {
                    maxWidth: "100%",
                    maxHeight:
                      attType === UfsChatType.sticker ? "130px" : "220px",
                    borderRadius: "10px",
                    display: "block",
                    objectFit: "contain",
                  },
                })
              ),
              h(
                "a",
                {
                  href: att.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: (e) => e.stopPropagation(),
                  style: {
                    color: linkColor,
                    fontSize: "12px",
                    textDecoration: "underline",
                    display: "inline-block",
                    marginTop: "3px",
                  },
                },
                "↗ Mở ảnh trong tab mới"
              )
            )
          );
        } else if (attType === UfsChatType.video) {
          children.push(
            h(
              "div",
              { key: `rv_att_${idx}`, style: { marginTop: "6px" } },
              h("video", {
                src: att.url,
                controls: true,
                preload: "metadata",
                onClick: (e) => e.stopPropagation(),
                style: {
                  maxWidth: "100%",
                  maxHeight: "220px",
                  borderRadius: "10px",
                  display: "block",
                },
              }),
              h(
                "a",
                {
                  href: att.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: (e) => e.stopPropagation(),
                  style: {
                    color: linkColor,
                    fontSize: "12px",
                    textDecoration: "underline",
                    display: "inline-block",
                    marginTop: "3px",
                  },
                },
                "↗ Mở video trong tab mới"
              )
            )
          );
        } else if (
          attType === UfsChatType.audioclip ||
          attType === UfsChatType.sound
        ) {
          children.push(
            h(
              "div",
              { key: `rv_att_${idx}`, style: { marginTop: "6px" } },
              h("audio", {
                src: att.url,
                controls: true,
                preload: "metadata",
                onClick: (e) => e.stopPropagation(),
                style: {
                  maxWidth: "220px",
                  height: "36px",
                  display: "block",
                },
              }),
              h(
                "a",
                {
                  href: att.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: (e) => e.stopPropagation(),
                  style: {
                    color: linkColor,
                    fontSize: "12px",
                    textDecoration: "underline",
                    display: "inline-block",
                    marginTop: "3px",
                  },
                },
                "↗ Mở âm thanh trong tab mới"
              )
            )
          );
        } else {
          children.push(
            h(
              "div",
              { key: `rv_att_${idx}`, style: { marginTop: "4px" } },
              h(
                "a",
                {
                  href: att.url,
                  target: "_blank",
                  rel: "noopener noreferrer",
                  onClick: (e) => e.stopPropagation(),
                  style: {
                    color: linkColor,
                    fontSize: "13px",
                    textDecoration: "underline",
                    wordBreak: "break-all",
                  },
                },
                att.url
              )
            )
          );
        }
      });
    }

    return h(
      "div",
      {
        dir: "auto",
        className: "ufs-rvdfm-revealed-bubble",
        style: {
          backgroundColor: bg,
          color: fg,
          borderRadius: "18px",
          padding: "8px 12px",
          maxWidth: "480px",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
          textAlign: "left",
          display: "inline-block",
          boxSizing: "border-box",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.12)",
        },
      },
      ...children
    );
  }

  function hookUnsentMessageComponent() {
    if (typeof window.requireLazy !== "function") return;
    window.requireLazy(
      ["MWV2ChatUnsentMessage.react"],
      (MWV2ChatUnsentMessage) => {
        if (
          !MWV2ChatUnsentMessage ||
          MWV2ChatUnsentMessage.__ufs_rvdfm_hooked
        ) {
          return;
        }
        MWV2ChatUnsentMessage.__ufs_rvdfm_hooked = true;

        const wrapFn = (originFn) =>
          function (a) {
            try {
              if (a && a.message && a.message.isUnsent) {
                const messageId = a.message.messageId;
                const savedMsg = normalizeEntry(
                  window.ufs_rvdfm_all_msgs[messageId]
                );
                const h = getReactCreateElement();
                if (typeof h === "function") {
                  return buildRevealedReactElement(h, a, savedMsg);
                }

                a.message.isUnsent = false;
                a.message.displayedContentTypes = [0, 1];
                if (savedMsg) {
                  const title = `[Tin thu hồi - ${savedMsg.type}]:\n`;
                  a.message.text = title + `${savedMsg.data}`;
                } else {
                  a.message.text = "[Tin thu hồi]: -Không có dữ liệu-";
                }
              }
            } catch (e) {}
            return originFn.apply(this, arguments);
          };

        const target = MWV2ChatUnsentMessage.MWV2ChatUnsentMessage;
        if (typeof target === "function") {
          const wrapped = wrapFn(target);
          MWV2ChatUnsentMessage.MWV2ChatUnsentMessage = wrapped;
          if (MWV2ChatUnsentMessage.default === target) {
            MWV2ChatUnsentMessage.default = wrapped;
          }
        } else if (target && typeof target.type === "function") {
          target.type = wrapFn(target.type);
        }
      }
    );
  }

  window.addEventListener("load", hookUnsentMessageComponent);
  if (document.readyState === "complete") {
    hookUnsentMessageComponent();
  }

  window.__ufs_rvdfm_initialized = true;
  window.__ufs_rvdfm_version = CURRENT_VERSION;
})();
