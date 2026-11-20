// Tự động nạp inject_websocket.js (v0.0.6) vào các tab Facebook / Messenger đang mở
async function injectIntoOpenMessengerTabs() {
  try {
    const tabs = await chrome.tabs.query({
      url: ["*://*.facebook.com/*", "*://*.messenger.com/*"],
    });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: ["inject_websocket.js"],
        });
      } catch (e) {}
    }
  } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => {
  injectIntoOpenMessengerTabs();
});

injectIntoOpenMessengerTabs();
