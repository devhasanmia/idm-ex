document.addEventListener("DOMContentLoaded", async () => {
  const daemonStatus = document.getElementById("daemonStatus");
  const urlInput = document.getElementById("urlInput");
  const startBtn = document.getElementById("startBtn");
  const dashBtn = document.getElementById("dashBtn");

  try {
    const res = await fetch("http://127.0.0.1:8080/api/tasks");
    if (res.ok) {
      daemonStatus.innerHTML = '<span class="status-dot"></span> Engine Online';
    } else {
      daemonStatus.innerHTML = '<span class="status-dot offline"></span> Offline';
    }
  } catch (e) {
    daemonStatus.innerHTML = '<span class="status-dot offline"></span> Engine Offline (Run idm-rs)';
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
        startBtn.innerText = "✓ Sent to IDM-RS!";
        setTimeout(() => {
          startBtn.innerText = "⚡ Accelerated Download";
          urlInput.value = "";
        }, 1500);
      } else {
        alert("Server returned error");
        startBtn.innerText = "⚡ Accelerated Download";
      }
    } catch (e) {
      alert("Could not reach IDM-RS engine. Make sure idm-rs is running!");
      startBtn.innerText = "⚡ Accelerated Download";
    }
  });

  dashBtn.addEventListener("click", () => {
    chrome.tabs.create({ url: "http://127.0.0.1:8080" });
  });
});

