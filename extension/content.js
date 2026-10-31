// IDM-RS Content Script: Floating Video Download Panel (Like IDM Video Grabber with Quality Selector)

(function () {
  if (window.__idm_rs_injected__) return;
  window.__idm_rs_injected__ = true;

  const style = document.createElement('style');
  style.textContent = `
    .idm-rs-video-container {
      position: absolute;
      top: 12px;
      right: 12px;
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
      user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .idm-rs-video-btn {
      background: linear-gradient(135deg, #1d4ed8, #06b6d4);
      color: #ffffff;
      font-size: 12px;
      font-weight: 700;
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), 0 0 10px rgba(6, 182, 212, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.2);
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s ease;
      opacity: 0.9;
    }
    .idm-rs-video-btn:hover {
      opacity: 1;
      transform: scale(1.03);
      box-shadow: 0 6px 20px rgba(6, 182, 212, 0.6);
    }
    .idm-rs-quality-menu {
      display: none;
      background: rgba(17, 24, 39, 0.95);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 8px;
      padding: 6px;
      flex-direction: column;
      gap: 4px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.6);
      min-width: 130px;
    }
    .idm-rs-video-container:hover .idm-rs-quality-menu {
      display: flex;
    }
    .idm-rs-q-item {
      padding: 5px 10px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 600;
      color: #e2e8f0;
      cursor: pointer;
      transition: all 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .idm-rs-q-item:hover {
      background: #2563eb;
      color: #fff;
    }
    .idm-rs-toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #111827;
      color: #34d399;
      border: 1px solid #10b981;
      border-radius: 8px;
      padding: 12px 20px;
      font-size: 13px;
      font-weight: 600;
      box-shadow: 0 8px 24px rgba(0,0,0,0.6);
      z-index: 1000000;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: idmFadeIn 0.3s ease;
    }
    @keyframes idmFadeIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);

  function attachDownloadButton(videoEl) {
    if (videoEl.__idm_attached__) return;
    videoEl.__idm_attached__ = true;

    const parent = videoEl.parentElement;
    if (!parent) return;

    const computed = window.getComputedStyle(parent);
    if (computed.position === 'static') {
      parent.style.position = 'relative';
    }

    const container = document.createElement('div');
    container.className = 'idm-rs-video-container';

    const btn = document.createElement('div');
    btn.className = 'idm-rs-video-btn';
    btn.innerHTML = '⚡ Download Video';

    const menu = document.createElement('div');
    menu.className = 'idm-rs-quality-menu';
    menu.innerHTML = `
      <div class="idm-rs-q-item" data-q="1080p"><span>⚡ 1080p Full HD</span></div>
      <div class="idm-rs-q-item" data-q="720p"><span>🎬 720p HD</span></div>
      <div class="idm-rs-q-item" data-q="360p"><span>📱 360p SD</span></div>
      <div class="idm-rs-q-item" data-q="audio"><span>🎵 Audio Only</span></div>
    `;

    // Default click: 1080p
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      await triggerDownload('1080p', videoEl);
    });

    menu.querySelectorAll('.idm-rs-q-item').forEach(item => {
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

    // If on YouTube, query the active audio track to show in button/menu
    if (location.hostname.includes('youtube.com')) {
      getYouTubeActiveAudioTrack().then(track => {
        if (track && (track.displayName || track.id)) {
          const trackName = track.displayName || track.id;
          btn.innerHTML = `⚡ Download [${trackName}]`;
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
        container.style.opacity = '0.3';
      }, 2000);
    });
  }

  function getYouTubeActiveAudioTrack() {
    return new Promise((resolve) => {
      if (!location.hostname.includes('youtube.com')) return resolve(null);

      const handler = (e) => {
        window.removeEventListener('__idm_audio_track_res__', handler);
        resolve(e.detail);
      };
      window.addEventListener('__idm_audio_track_res__', handler);

      const script = document.createElement('script');
      script.textContent = `
        (function() {
          try {
            const player = document.getElementById('movie_player');
            const track = player && typeof player.getAudioTrack === 'function' ? player.getAudioTrack() : null;
            window.dispatchEvent(new CustomEvent('__idm_audio_track_res__', { detail: track }));
          } catch (e) {
            window.dispatchEvent(new CustomEvent('__idm_audio_track_res__', { detail: null }));
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

    sendToIdm(targetUrl, quality, audioTrack);
  }

  function sendToIdm(url, quality = '1080p', audioTrack = null) {
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
          showToast(`✓ [${quality.toUpperCase()}${trackLabel}] Transferred to IDM-RS Turbo Downloader!`);
        } else {
          showToast('⚠️ Could not connect to IDM-RS. Make sure IDM-RS is running!');
        }
      })
      .catch(() => {
        showToast('⚠️ Could not connect to IDM-RS on port 8080.');
      });
  }

  function showToast(msg) {
    const existing = document.querySelector('.idm-rs-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'idm-rs-toast';
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
