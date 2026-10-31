// Downly Content Script: Soft Modern Floating Video Download Pill & Quality Selector

(function () {
  if (window.__downly_injected__) return;
  window.__downly_injected__ = true;

  const style = document.createElement('style');
  style.textContent = `
    .downly-video-container {
      position: absolute;
      top: 14px;
      right: 14px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      transition: opacity 0.25s ease;
    }
    .downly-video-btn {
      background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
      color: #ffffff;
      font-size: 12.5px;
      font-weight: 600;
      padding: 7px 14px;
      border-radius: 999px;
      cursor: pointer;
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.25);
      display: flex;
      align-items: center;
      gap: 7px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      backdrop-filter: blur(8px);
    }
    .downly-video-btn:hover {
      transform: translateY(-1px) scale(1.02);
      box-shadow: 0 8px 24px rgba(99, 102, 241, 0.55);
    }
    .downly-quality-menu {
      display: none;
      background: rgba(255, 255, 255, 0.96);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(226, 232, 240, 0.9);
      border-radius: 14px;
      padding: 6px;
      flex-direction: column;
      gap: 3px;
      box-shadow: 0 12px 30px rgba(15, 23, 42, 0.18);
      min-width: 148px;
    }
    .downly-video-container:hover .downly-quality-menu {
      display: flex;
    }
    .downly-q-item {
      padding: 7px 11px;
      border-radius: 9px;
      font-size: 12px;
      font-weight: 600;
      color: #334155;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .downly-q-item:hover {
      background: rgba(99, 102, 241, 0.1);
      color: #6366f1;
    }
    .downly-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #ffffff;
      color: #1e293b;
      border: 1px solid #e2e8f0;
      border-left: 4px solid #6366f1;
      border-radius: 14px;
      padding: 12px 18px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 12px 32px rgba(15, 23, 42, 0.15);
      z-index: 1000000;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: downlyFadeIn 0.25s ease;
    }
    @keyframes downlyFadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);

  const downArrowSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>`;

  function attachDownloadButton(videoEl) {
    if (videoEl.__downly_attached__) return;
    videoEl.__downly_attached__ = true;

    const parent = videoEl.parentElement;
    if (!parent) return;

    const computed = window.getComputedStyle(parent);
    if (computed.position === 'static') {
      parent.style.position = 'relative';
    }

    const container = document.createElement('div');
    container.className = 'downly-video-container';

    const btn = document.createElement('div');
    btn.className = 'downly-video-btn';
    btn.innerHTML = `${downArrowSvg} <span>Downly Video</span>`;

    const menu = document.createElement('div');
    menu.className = 'downly-quality-menu';
    menu.innerHTML = `
      <div class="downly-q-item" data-q="1080p"><span>1080p Full HD</span><span style="font-size:10px;color:#6366f1;">MP4</span></div>
      <div class="downly-q-item" data-q="720p"><span>720p HD</span><span style="font-size:10px;color:#64748b;">MP4</span></div>
      <div class="downly-q-item" data-q="360p"><span>360p Standard</span><span style="font-size:10px;color:#64748b;">MP4</span></div>
      <div class="downly-q-item" data-q="audio"><span>Audio Only</span><span style="font-size:10px;color:#ec4899;">M4A</span></div>
    `;

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await triggerDownload('1080p', videoEl);
    });

    menu.querySelectorAll('.downly-q-item').forEach(item => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const q = item.getAttribute('data-q');
        await triggerDownload(q, videoEl);
      });
    });

    container.appendChild(btn);
    container.appendChild(menu);
    parent.appendChild(container);

    if (location.hostname.includes('youtube.com')) {
      getYouTubeActiveAudioTrack().then(track => {
        if (track && (track.displayName || track.id)) {
          const trackName = track.displayName || track.id;
          btn.innerHTML = `${downArrowSvg} <span>Downly • ${trackName}</span>`;
        }
      });
    }

    let hideTimeout;
    parent.addEventListener('mouseenter', () => {
      clearTimeout(hideTimeout);
      container.style.opacity = '1';
    });
    parent.addEventListener('mouseleave', () => {
      hideTimeout = setTimeout(() => {
        container.style.opacity = '0.25';
      }, 2000);
    });
  }

  function getYouTubeActiveAudioTrack() {
    return new Promise((resolve) => {
      if (!location.hostname.includes('youtube.com')) return resolve(null);

      const handler = (e) => {
        window.removeEventListener('__downly_audio_track_res__', handler);
        resolve(e.detail);
      };
      window.addEventListener('__downly_audio_track_res__', handler);

      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            const player = document.getElementById('movie_player');
            const track = player && typeof player.getAudioTrack === 'function' ? player.getAudioTrack() : null;
            window.dispatchEvent(new CustomEvent('__downly_audio_track_res__', { detail: track }));
          } catch (e) {
            window.dispatchEvent(new CustomEvent('__downly_audio_track_res__', { detail: null }));
          }
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();

      setTimeout(() => resolve(null), 250);
    });
  }

  async function triggerDownload(quality, videoEl, customAudioTrack) {
    let targetUrl = window.location.href;
    if (videoEl.src && !videoEl.src.startsWith('blob:') && !location.hostname.includes('youtube.com')) {
      targetUrl = videoEl.src;
    }

    let audioTrack = customAudioTrack;
    if (!audioTrack && location.hostname.includes('youtube.com')) {
      const activeTrack = await getYouTubeActiveAudioTrack();
      if (activeTrack && (activeTrack.id || activeTrack.displayName)) {
        audioTrack = activeTrack.id || activeTrack.displayName;
      }
    }

    sendToDownly(targetUrl, quality, audioTrack);
  }

  function sendToDownly(url, quality = '1080p', audioTrack = null) {
    fetch('http://127.0.0.1:8080/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url,
        quality: quality,
        audioTrack: audioTrack,
        connections: 16
      })
    })
      .then(res => {
        if (res.ok) {
          const trackLabel = audioTrack ? ` (${audioTrack})` : '';
          showToast(`✓ [${quality.toUpperCase()}${trackLabel}] Added to Downly!`);
        } else {
          showToast('⚠️ Could not connect to Downly. Make sure Downly is running!');
        }
      })
      .catch(() => {
        showToast('⚠️ Could not connect to Downly on port 8080.');
      });
  }

  function showToast(msg) {
    const existing = document.querySelector('.downly-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'downly-toast';
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  }

  function scanVideos() {
    const videos = document.querySelectorAll('video');
    videos.forEach(v => {
      if (v.offsetWidth > 150 && v.offsetHeight > 100) {
        attachDownloadButton(v);
      }
    });
  }

  setInterval(scanVideos, 2000);
  const observer = new MutationObserver(scanVideos);
  observer.observe(document.body, { childList: true, subtree: true });
})();
