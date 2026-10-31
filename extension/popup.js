document.addEventListener("DOMContentLoaded", async () => {
  const daemonStatus = document.getElementById("daemonStatus");
  const urlInput = document.getElementById("urlInput");
  const startBtn = document.getElementById("startBtn");
  const dashBtn = document.getElementById("dashBtn");

  try {
    const res = await fetch("http://127.0.0.1:8080/api/tasks");
    if (res.ok) {
      daemonStatus.innerHTML = '<span class="status-dot"></span> Downly Online';
    } else {
      daemonStatus.innerHTML = '<span class="status-dot offline"></span> Offline';
    }
  } catch (e) {
    daemonStatus.innerHTML = '<span class="status-dot offline"></span> Offline (Start Downly)';
  }

  startBtn.addEventListener("click", async () => {
    const url = urlInput.value.trim();
    if (!url) return;

    try {
      startBtn.innerText = "Starting...";
      const res = await fetch("http://127.0.0.1:8080/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, connections: 16 })
      });

      if (res.ok) {
        startBtn.innerText = "✓ Sent to Downly!";
        setTimeout(() => {
          startBtn.innerText = "Download with Downly";
          urlInput.value = "";
        }, 1500);
      } else {
        alert("Server returned error");
        startBtn.innerText = "Download with Downly";
      }
    } catch (e) {
      alert("Could not reach Downly engine. Make sure Downly is running!");
      startBtn.innerText = "Download with Downly";
    }
  });

  dashBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "http://127.0.0.1:8080" });
  });
});
