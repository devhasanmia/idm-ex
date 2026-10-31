// IDM-RS Browser Extension Background Service Worker

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "idm-rs-download-link",
    title: "⚡ Download with IDM-RS",
    contexts: ["link", "video", "audio", "image"]
  });

  chrome.contextMenus.create({
    id: "idm-rs-download-selected",
    title: "⚡ Download Selected URL with IDM-RS",
    contexts: ["selection"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let targetUrl = null;
  if (info.menuItemId === "idm-rs-download-link") {
    targetUrl = info.linkUrl || info.srcUrl;
  } else if (info.menuItemId === "idm-rs-download-selected") {
    targetUrl = info.selectionText ? info.selectionText.trim() : null;
  }

  if (targetUrl && (targetUrl.startsWith("http://") || targetUrl.startsWith("https://"))) {
    await sendToIdmRs(targetUrl);
  }
});

async function sendToIdmRs(url) {
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
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
      setTimeout(() => chrome.action.setBadgeText({ text: "" }), 3000);
    } else {
      showErrorBadge();
    }
  } catch (err) {
    console.error("Failed to connect to IDM-RS daemon:", err);
    showErrorBadge();
  }
}

function showErrorBadge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

