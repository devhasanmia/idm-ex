// Downly Browser Extension Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "downly-download-link",
    title: "⬇ Download with Downly",
    contexts: ["link", "video", "audio", "image"]
  });

  chrome.contextMenus.create({
    id: "downly-download-selected",
    title: "⬇ Download Selected URL with Downly",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let targetUrl = null;
  if (info.menuItemId === "downly-download-link") {
    targetUrl = info.linkUrl || info.srcUrl;
  } else if (info.menuItemId === "downly-download-selected") {
    targetUrl = info.selectionText ? info.selectionText.trim() : null;
  }

  if (targetUrl && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
    await sendToDownly(targetUrl);
  }
});

async function sendToDownly(url) {
  try {
    const res = await fetch("http://127.0.0.1:8080/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url,
        connections: 16
      })
    });

    if (res.ok) {
      chrome.action.setBadgeText({ text: "✓" });
      chrome.action.setBadgeBackgroundColor({ color: "#6366f1" });
      setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
    } else {
      showErrorBadge();
    }
  } catch (err) {
    console.error("Failed to connect to Downly daemon:", err);
    showErrorBadge();
  }
}

function showErrorBadge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#f43f5e" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}
