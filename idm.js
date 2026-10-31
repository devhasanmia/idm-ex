#!/usr/bin/env node

/**
 * ⚡ IDM-RS Turbo Download Accelerator
 * High-performance Dynamic Multi-Segment Downloader & Web Dashboard
 * With Full HD Video Quality Selector & Automatic Audio Muxing (FFmpeg)
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const url = require('node:url');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn } = require('node:child_process');
const ffmpegPath = require('ffmpeg-static');
const { Ytdl } = require('@distube/ytdl-core');

const PORT = 8080;
const MIN_SPLIT_SIZE = 2 * 1024 * 1024; // 2 MB minimum to dynamically split
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function getDefaultDownloadDir() {
  const home = os.homedir();
  const downloads = path.join(home, 'Downloads');
  if (fs.existsSync(downloads)) return downloads;
  return process.cwd();
}

function isYouTubeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  } catch (e) {
    return false;
  }
}

function sanitizeFileName(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').trim() || `file_${Date.now()}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatSpeed(bps) {
  return formatBytes(bps) + '/s';
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const s = parseInt(seconds, 10);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}:${remS < 10 ? '0' : ''}${remS}`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return `${h}:${remM < 10 ? '0' : ''}${remM}:${remS < 10 ? '0' : ''}${remS}`;
}

// -----------------------------------------------------------------------------
// FFmpeg Video + Audio Remuxer (Lossless Video Copy + Stereo AAC Audio)
// -----------------------------------------------------------------------------

function mergeVideoAndAudio(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-shortest',
      outputPath
    ];

    const proc = spawn(ffmpegPath, args);
    let errOutput = '';
    proc.stderr.on('data', d => (errOutput += d.toString()));
    proc.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
        resolve(true);
      } else {
        reject(new Error(`FFmpeg merge error (${code}): ${errOutput.slice(-300)}`));
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Core Engine: Dynamic Segmentation & Direct Positioned I/O
// -----------------------------------------------------------------------------

class Segment {
  constructor(id, startByte, endByte) {
    this.id = id;
    this.startByte = startByte;
    this.endByte = endByte; // inclusive
    this.downloadedBytes = 0;
    this.status = 'Pending'; // 'Pending' | 'Downloading' | 'Completed' | 'Paused'
  }

  totalBytes() {
    return this.endByte >= this.startByte ? this.endByte - this.startByte + 1 : 0;
  }

  remainingBytes() {
    const total = this.totalBytes();
    return this.downloadedBytes >= total ? 0 : total - this.downloadedBytes;
  }

  currentPos() {
    return this.startByte + this.downloadedBytes;
  }

  isCompleted() {
    return this.downloadedBytes >= this.totalBytes();
  }

  split(newId, minChunkSize) {
    const rem = this.remainingBytes();
    if (rem < minChunkSize * 2) return null;

    const currentHead = this.currentPos();
    const half = Math.floor(rem / 2);
    const newSegStart = currentHead + half;
    const originalEnd = this.endByte;

    this.endByte = newSegStart - 1;
    return new Segment(newId, newSegStart, originalEnd);
  }
}

class DownloadTask {
  constructor(options) {
    this.id = options.id || crypto.randomUUID();
    this.url = options.url;
    this.downloadDir = options.downloadDir || getDefaultDownloadDir();
    this.fileName = options.fileName || this.inferFileName(this.url);
    this.outputPath = path.join(this.downloadDir, this.fileName);
    this.connections = Math.min(64, Math.max(1, options.connections || 16));
    this.speedLimitBps = options.speedLimitBps || 0;
    this.requestedQuality = options.quality || '1080p'; // '1080p' | '720p' | '480p' | '360p' | 'audio'

    this.totalSize = 0;
    this.supportsRange = false;
    this.status = 'Queued'; // 'Queued' | 'Connecting' | 'Downloading' | 'Muxing' | 'Paused' | 'Completed' | 'Failed'
    this.downloadedBytes = 0;
    this.speedBps = 0;
    this.error = null;

    // Video & Audio streams for DASH / YouTube
    this.isVideoMuxed = false;
    this.videoStreamUrl = null;
    this.videoSize = 0;
    this.videoSegments = [];
    this.videoTempPath = path.join(this.downloadDir, `${this.id}_v.tmp`);

    this.audioStreamUrl = null;
    this.audioSize = 0;
    this.audioSegments = [];
    this.audioTempPath = path.join(this.downloadDir, `${this.id}_a.tmp`);

    // Standard single stream
    this.segments = [];

    this._abortControllers = [];
    this._vFileHandle = null;
    this._aFileHandle = null;
    this._fileHandle = null;
    this._monitorInterval = null;
    this._lastBytes = 0;
  }

  inferFileName(rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      const pathname = parsed.pathname;
      const last = path.basename(pathname).trim();
      if (last && last.length > 0) return sanitizeFileName(last);
    } catch (e) {}
    return `download_${Date.now()}`;
  }

  getSnapshot() {
    const progress = this.totalSize > 0
      ? Math.min(100, (this.downloadedBytes / this.totalSize) * 100)
      : 0;
    const eta = this.speedBps > 0 && this.totalSize > this.downloadedBytes
      ? Math.floor((this.totalSize - this.downloadedBytes) / this.speedBps)
      : null;

    const displaySegments = this.isVideoMuxed
      ? this.videoSegments.concat(this.audioSegments)
      : this.segments;

    return {
      id: this.id,
      url: this.url,
      file_name: this.fileName,
      output_path: this.outputPath,
      total_size: this.totalSize,
      downloaded_bytes: this.downloadedBytes,
      speed_bps: this.speedBps,
      status: this.status,
      progress_percent: progress,
      eta_seconds: eta,
      connections: this.connections,
      quality: this.requestedQuality,
      segments: displaySegments.map(s => ({
        id: s.id,
        start_byte: s.startByte,
        end_byte: s.endByte,
        downloaded_bytes: s.downloadedBytes,
        status: s.status
      })),
      error: this.error
    };
  }

  async start() {
    if (this.status === 'Downloading' || this.status === 'Muxing') return;
    this.status = 'Connecting';
    this.error = null;

    try {
      await fsp.mkdir(this.downloadDir, { recursive: true });

      if (isYouTubeUrl(this.url)) {
        await this.resolveYouTube();
      } else {
        await this.probeServer();
      }

      this.status = 'Downloading';
      this.startSpeedMonitor();

      if (this.isVideoMuxed) {
        await this.runMuxedDownload();
      } else {
        await this.runStandardDownload();
      }
    } catch (err) {
      this.status = 'Failed';
      this.error = err.message;
      await this.cleanup();
    }
  }

  async resolveYouTube() {
    const ytdl = new Ytdl();
    const info = await ytdl.getInfo(this.url);
    const title = info.videoDetails && info.videoDetails.title
      ? info.videoDetails.title
      : `YouTube_Video_${Date.now()}`;

    const formats = info.formats || [];

    // Find best audio track (AAC M4A / highest bitrate)
    const audioFormats = formats
      .filter(f => f.hasAudio && !f.hasVideo && f.url)
      .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0));

    const audioFormat = audioFormats.find(f => f.container === 'mp4' || (f.codecs && f.codecs.includes('mp4a')))
                     || audioFormats[0];

    if (this.requestedQuality === 'audio') {
      if (!audioFormat) throw new Error('No audio format found for this video.');
      this.fileName = sanitizeFileName(title) + '.m4a';
      this.outputPath = path.join(this.downloadDir, this.fileName);
      this.url = audioFormat.url;
      this.totalSize = parseInt(audioFormat.contentLength || '0', 10);
      this.supportsRange = true;
      this.isVideoMuxed = false;
      this.createSegmentsForStream('single', this.totalSize, this.connections);
      return;
    }

    // Requested video quality
    let targetFormat = null;
    const qPref = (this.requestedQuality || '1080p').toLowerCase();

    if (qPref.includes('1080')) {
      targetFormat = formats.find(f => f.hasVideo && f.url && f.container === 'mp4' && (f.qualityLabel === '1080p' || f.qualityLabel === '1080p60'))
                  || formats.find(f => f.hasVideo && f.url && (f.qualityLabel === '1080p' || f.qualityLabel === '1080p60'));
    } else if (qPref.includes('720')) {
      targetFormat = formats.find(f => f.hasVideo && f.url && f.container === 'mp4' && (f.qualityLabel === '720p' || f.qualityLabel === '720p60'))
                  || formats.find(f => f.hasVideo && f.url && (f.qualityLabel === '720p' || f.qualityLabel === '720p60'));
    } else if (qPref.includes('480')) {
      targetFormat = formats.find(f => f.hasVideo && f.url && f.container === 'mp4' && f.qualityLabel === '480p')
                  || formats.find(f => f.hasVideo && f.url && f.qualityLabel === '480p');
    } else if (qPref.includes('360')) {
      targetFormat = formats.find(f => f.hasVideo && f.url && f.container === 'mp4' && f.qualityLabel === '360p')
                  || formats.find(f => f.hasVideo && f.url && f.qualityLabel === '360p');
    }

    if (!targetFormat) {
      targetFormat = formats.find(f => f.hasVideo && f.url && f.container === 'mp4')
                  || formats.find(f => f.hasVideo && f.url);
    }

    if (!targetFormat) throw new Error('No suitable video format found.');

    this.fileName = sanitizeFileName(title) + '.mp4';
    this.outputPath = path.join(this.downloadDir, this.fileName);

    const vLen = parseInt(targetFormat.contentLength || '0', 10);
    const aLen = audioFormat ? parseInt(audioFormat.contentLength || '0', 10) : 0;

    if (audioFormat && !targetFormat.hasAudio) {
      this.isVideoMuxed = true;
      this.videoStreamUrl = targetFormat.url;
      this.videoSize = vLen;
      this.audioStreamUrl = audioFormat.url;
      this.audioSize = aLen;
      this.totalSize = vLen + aLen;
      this.supportsRange = true;

      const vThreads = Math.max(1, Math.floor(this.connections * 0.75));
      const aThreads = Math.max(1, this.connections - vThreads);
      this.createSegmentsForStream('video', this.videoSize, vThreads);
      this.createSegmentsForStream('audio', this.audioSize, aThreads);
    } else {
      this.isVideoMuxed = false;
      this.url = targetFormat.url;
      this.totalSize = vLen;
      this.supportsRange = true;
      this.createSegmentsForStream('single', this.totalSize, this.connections);
    }
  }

  async probeServer() {
    return new Promise((resolve) => {
      const parsedUrl = new URL(this.url);
      const isHttps = parsedUrl.protocol === 'https:';
      const transport = isHttps ? https : http;

      const req = transport.request(
        this.url,
        {
          method: 'HEAD',
          headers: { 'User-Agent': DEFAULT_USER_AGENT },
          timeout: 10000
        },
        (res) => {
          const headers = res.headers;
          let contentLength = parseInt(headers['content-length'] || '0', 10);
          const acceptRanges = (headers['accept-ranges'] || '').toLowerCase();
          const supportsRange = acceptRanges.includes('bytes');

          const cd = headers['content-disposition'];
          if (cd && cd.includes('filename=')) {
            const match = cd.match(/filename=["']?([^"';]+)["']?/);
            if (match && match[1]) {
              this.fileName = sanitizeFileName(match[1].trim());
              this.outputPath = path.join(this.downloadDir, this.fileName);
            }
          }

          if (contentLength > 0) {
            this.totalSize = contentLength;
            this.supportsRange = supportsRange;
            this.createSegmentsForStream('single', this.totalSize, this.connections);
            return resolve();
          }

          // Fallback probe GET Range: bytes=0-0
          const getReq = transport.request(
            this.url,
            {
              method: 'GET',
              headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Range': 'bytes=0-0' },
              timeout: 10000
            },
            (getRes) => {
              const gh = getRes.headers;
              const cr = gh['content-range'] || '';
              if (getRes.statusCode === 206 || cr) {
                this.supportsRange = true;
                const match = cr.match(/\/(\d+)$/);
                if (match && match[1]) this.totalSize = parseInt(match[1], 10);
              }
              if (!this.totalSize) this.totalSize = parseInt(gh['content-length'] || '0', 10);
              getRes.destroy();
              this.createSegmentsForStream('single', this.totalSize, this.connections);
              resolve();
            }
          );
          getReq.on('error', () => {
            this.createSegmentsForStream('single', this.totalSize, 1);
            resolve();
          });
          getReq.end();
        }
      );

      req.on('error', () => {
        this.createSegmentsForStream('single', this.totalSize, 1);
        resolve();
      });
      req.end();
    });
  }

  createSegmentsForStream(streamType, totalBytes, count) {
    const segments = [];
    if (totalBytes <= 0 || count <= 1) {
      segments.push(new Segment(0, 0, totalBytes > 0 ? totalBytes - 1 : 0));
    } else {
      const chunkSize = Math.floor(totalBytes / count);
      let start = 0;
      for (let i = 0; i < count; i++) {
        const end = i === count - 1 ? totalBytes - 1 : start + chunkSize - 1;
        segments.push(new Segment(i, start, end));
        start = end + 1;
      }
    }

    if (streamType === 'video') this.videoSegments = segments;
    else if (streamType === 'audio') this.audioSegments = segments;
    else this.segments = segments;
  }

  startSpeedMonitor() {
    this._lastBytes = this.downloadedBytes;
    this._monitorInterval = setInterval(() => {
      if (this.status !== 'Downloading') {
        clearInterval(this._monitorInterval);
        return;
      }
      const diff = this.downloadedBytes - this._lastBytes;
      this.speedBps = Math.max(0, diff);
      this._lastBytes = this.downloadedBytes;
    }, 1000);
  }

  async runStandardDownload() {
    this._fileHandle = await fsp.open(this.outputPath, 'w+');
    if (this.totalSize > 0) {
      const stats = await this._fileHandle.stat();
      if (stats.size < this.totalSize) await this._fileHandle.truncate(this.totalSize);
    }

    const workerPromises = this.segments.map(s => this.downloadSegmentStream(this.url, s, this._fileHandle));
    await Promise.all(workerPromises);

    if (this.status === 'Downloading') {
      this.status = 'Completed';
      this.speedBps = 0;
    }
    await this.cleanup();
  }

  async runMuxedDownload() {
    this._vFileHandle = await fsp.open(this.videoTempPath, 'w+');
    if (this.videoSize > 0) await this._vFileHandle.truncate(this.videoSize);

    this._aFileHandle = await fsp.open(this.audioTempPath, 'w+');
    if (this.audioSize > 0) await this._aFileHandle.truncate(this.audioSize);

    const vPromises = this.videoSegments.map(s => this.downloadSegmentStream(this.videoStreamUrl, s, this._vFileHandle));
    const aPromises = this.audioSegments.map(s => this.downloadSegmentStream(this.audioStreamUrl, s, this._aFileHandle));

    await Promise.all([...vPromises, ...aPromises]);

    if (this.status === 'Downloading') {
      this.status = 'Muxing';
      this.speedBps = 0;

      await this.cleanup();

      const vStat = fs.existsSync(this.videoTempPath) ? fs.statSync(this.videoTempPath) : null;
      const aStat = fs.existsSync(this.audioTempPath) ? fs.statSync(this.audioTempPath) : null;

      if (!vStat || vStat.size === 0) {
        throw new Error('Video stream download failed or is empty.');
      }

      if (!aStat || aStat.size === 0) {
        console.warn(`[IDM-RS] ⚠️ Audio stream empty. Keeping video only.`);
        await fsp.copyFile(this.videoTempPath, this.outputPath);
        try { await fsp.unlink(this.videoTempPath); } catch (e) {}
        this.status = 'Completed';
        return;
      }

      try {
        console.log(`[IDM-RS] Muxing video and audio into ${this.outputPath}...`);
        await mergeVideoAndAudio(this.videoTempPath, this.audioTempPath, this.outputPath);

        try { await fsp.unlink(this.videoTempPath); } catch (e) {}
        try { await fsp.unlink(this.audioTempPath); } catch (e) {}

        this.status = 'Completed';
        console.log(`[IDM-RS] ✅ Video + Audio successfully merged: ${this.outputPath}`);
      } catch (muxErr) {
        console.error('[IDM-RS] Mux error:', muxErr.message);
        try {
          await fsp.copyFile(this.videoTempPath, this.outputPath);
        } catch (e) {}
        this.status = 'Completed';
      }
    }
  }

  async downloadSegmentStream(streamUrl, segment, fileHandle) {
    return new Promise((resolve) => {
      const currentPos = segment.currentPos();
      if (segment.endByte > 0 && currentPos > segment.endByte) return resolve(true);

      const headers = { 'User-Agent': DEFAULT_USER_AGENT };
      if (this.supportsRange) {
        headers['Range'] = segment.endByte > 0
          ? `bytes=${currentPos}-${segment.endByte}`
          : `bytes=${currentPos}-`;
      }

      const makeRequest = (targetUrl, redirectCount = 0) => {
        if (redirectCount > 5) return resolve(false);

        const parsedUrl = new URL(targetUrl);
        const transport = parsedUrl.protocol === 'https:' ? https : http;

        const req = transport.request(targetUrl, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const nextUrl = new URL(res.headers.location, targetUrl).toString();
            return makeRequest(nextUrl, redirectCount + 1);
          }

          if (res.statusCode !== 200 && res.statusCode !== 206) return resolve(false);

          let writeQueue = Promise.resolve();

          res.on('data', (chunk) => {
            if (this.status !== 'Downloading') {
              res.destroy();
              return resolve(false);
            }

            const len = chunk.length;
            const writeOffset = segment.currentPos();
            segment.downloadedBytes += len;
            this.downloadedBytes += len;

            if (fileHandle) {
              writeQueue = writeQueue.then(() => fileHandle.write(chunk, 0, len, writeOffset)).catch(e => {
                console.error(`[IDM-RS] Segment write error:`, e.message);
              });
            }

            if (segment.isCompleted()) {
              segment.status = 'Completed';
              try { req.destroy(); } catch (e) {}
              writeQueue.then(() => resolve(true));
            }
          });

          res.on('end', async () => {
            await writeQueue;
            segment.status = 'Completed';
            resolve(true);
          });
          res.on('error', async () => {
            await writeQueue;
            if (segment.isCompleted()) resolve(true);
            else resolve(false);
          });
        });

        req.on('error', () => {
          if (segment.isCompleted()) resolve(true);
          else resolve(false);
        });
        this._abortControllers.push(req);
        req.end();
      };

      makeRequest(streamUrl);
    });
  }

  async pause() {
    this.status = 'Paused';
    this.speedBps = 0;
    this.abortAll();
  }

  async cancel() {
    this.status = 'Failed';
    this.error = 'Cancelled by user';
    this.speedBps = 0;
    this.abortAll();
    await this.cleanup();
    try { if (fs.existsSync(this.videoTempPath)) await fsp.unlink(this.videoTempPath); } catch (e) {}
    try { if (fs.existsSync(this.audioTempPath)) await fsp.unlink(this.audioTempPath); } catch (e) {}
  }

  abortAll() {
    for (const req of this._abortControllers) {
      try { req.destroy(); } catch (e) {}
    }
    this._abortControllers = [];
  }

  async cleanup() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
    if (this._fileHandle) {
      try { await this._fileHandle.sync(); await this._fileHandle.close(); } catch (e) {}
      this._fileHandle = null;
    }
    if (this._vFileHandle) {
      try { await this._vFileHandle.sync(); await this._vFileHandle.close(); } catch (e) {}
      this._vFileHandle = null;
    }
    if (this._aFileHandle) {
      try { await this._aFileHandle.sync(); await this._aFileHandle.close(); } catch (e) {}
      this._aFileHandle = null;
    }
  }
}

// -----------------------------------------------------------------------------
// Download Manager State Store
// -----------------------------------------------------------------------------

class DownloadManager {
  constructor(downloadDir) {
    this.downloadDir = downloadDir || getDefaultDownloadDir();
    this.tasks = new Map();
  }

  addTask(options) {
    const task = new DownloadTask({
      ...options,
      downloadDir: this.downloadDir
    });
    this.tasks.set(task.id, task);
    task.start();
    return task;
  }

  getTask(id) {
    return this.tasks.get(id);
  }

  getAllSnapshots() {
    return Array.from(this.tasks.values()).map(t => t.getSnapshot());
  }

  async pauseTask(id) {
    const task = this.getTask(id);
    if (task) {
      await task.pause();
      return true;
    }
    return false;
  }

  async resumeTask(id) {
    const task = this.getTask(id);
    if (task && (task.status === 'Paused' || task.status === 'Failed')) {
      await task.start();
      return true;
    }
    return false;
  }

  async cancelTask(id) {
    const task = this.getTask(id);
    if (task) {
      await task.cancel();
      this.tasks.delete(id);
      return true;
    }
    return false;
  }
}

// -----------------------------------------------------------------------------
// Web Server, Quality Probe API & WebSocket Daemon
// -----------------------------------------------------------------------------

function startServer(manager, port = PORT, autoOpen = true) {
  const uiHtmlPath = path.join(__dirname, 'src', 'server', 'ui.html');
  const uiHtml = fs.readFileSync(uiHtmlPath, 'utf8');

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 1. Dashboard UI
    if (pathname === '/' || pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(uiHtml);
    }

    // 2. GET /api/tasks
    if (pathname === '/api/tasks' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(manager.getAllSnapshots()));
    }

    // 3. POST /api/probe: Inspect Video Quality options & metadata
    if (pathname === '/api/probe' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', async () => {
        try {
          const { url: targetUrl } = JSON.parse(body);
          if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing url' }));
          }

          if (isYouTubeUrl(targetUrl)) {
            const ytdl = new Ytdl();
            const info = await ytdl.getInfo(targetUrl);
            const formats = info.formats || [];

            const audio = formats.find(f => f.hasAudio && !f.hasVideo && f.url && f.container === 'mp4')
                       || formats.find(f => f.hasAudio && !f.hasVideo && f.url);
            const audioBytes = audio ? parseInt(audio.contentLength || '0', 10) : 0;

            const qualityMap = new Map();
            formats.forEach(f => {
              if (f.hasVideo && f.url && f.qualityLabel) {
                const q = f.qualityLabel.includes('1080') ? '1080p'
                        : f.qualityLabel.includes('720') ? '720p'
                        : f.qualityLabel.includes('480') ? '480p'
                        : f.qualityLabel.includes('360') ? '360p' : null;
                if (q && !qualityMap.has(q)) {
                  const vBytes = parseInt(f.contentLength || '0', 10);
                  qualityMap.set(q, {
                    id: q,
                    label: `${f.qualityLabel} Full HD (Video + Audio)`,
                    sizeBytes: vBytes + audioBytes,
                    sizeFormatted: formatBytes(vBytes + audioBytes)
                  });
                }
              }
            });

            const qualities = Array.from(qualityMap.values());
            if (audio) {
              qualities.push({
                id: 'audio',
                label: 'Audio Only (128kbps AAC M4A)',
                sizeBytes: audioBytes,
                sizeFormatted: formatBytes(audioBytes)
              });
            }

            const thumbnail = info.videoDetails.thumbnails?.slice(-1)[0]?.url || '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
              isVideo: true,
              title: info.videoDetails.title,
              thumbnail,
              duration: formatDuration(info.videoDetails.lengthSeconds),
              author: info.videoDetails.author?.name || '',
              qualities
            }));
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ isVideo: false, qualities: [] }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 4. POST /api/download
    if (pathname === '/api/download' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.url) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Missing url' }));
          }
          const task = manager.addTask({
            url: data.url,
            fileName: data.filename,
            quality: data.quality || '1080p',
            connections: parseInt(data.connections || '16', 10),
            speedLimitBps: parseInt(data.speed_limit || '0', 10)
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(task.getSnapshot()));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // 5. POST /api/tasks/:id/pause
    const pauseMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/pause$/);
    if (pauseMatch && req.method === 'POST') {
      const ok = await manager.pauseTask(pauseMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: ok }));
    }

    // 6. POST /api/tasks/:id/resume
    const resumeMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
    if (resumeMatch && req.method === 'POST') {
      const ok = await manager.resumeTask(resumeMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: ok }));
    }

    // 7. POST /api/tasks/:id/cancel
    const cancelMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === 'POST') {
      const ok = await manager.cancelTask(cancelMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: ok }));
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  // Native WebSocket upgrade handler (RFC 6455)
  server.on('upgrade', (req, socket) => {
    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    if (parsedUrl.pathname !== '/api/ws') {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`
    ];
    socket.write(headers.join('\r\n') + '\r\n\r\n');

    const timer = setInterval(() => {
      try {
        const json = JSON.stringify(manager.getAllSnapshots());
        const payload = Buffer.from(json);
        const len = payload.length;

        let frameHeader;
        if (len < 126) {
          frameHeader = Buffer.from([0x81, len]);
        } else if (len <= 65535) {
          frameHeader = Buffer.alloc(4);
          frameHeader[0] = 0x81;
          frameHeader[1] = 126;
          frameHeader.writeUInt16BE(len, 2);
        } else {
          frameHeader = Buffer.alloc(10);
          frameHeader[0] = 0x81;
          frameHeader[1] = 127;
          frameHeader.writeBigUInt64BE(BigInt(len), 2);
        }

        socket.write(Buffer.concat([frameHeader, payload]));
      } catch (e) {
        clearInterval(timer);
      }
    }, 300);

    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });

  server.listen(port, '127.0.0.1', () => {
    const localUrl = `http://127.0.0.1:${port}`;
    console.log('============================================================');
    console.log('⚡ IDM-RS Turbo Download Manager is running!');
    console.log(`🌐 Dashboard & Web UI: ${localUrl}`);
    console.log(`🧩 Browser Extension API: ${localUrl}/api/download`);
    console.log(`📁 Download directory: ${manager.downloadDir}`);
    console.log('============================================================');

    if (autoOpen) {
      const openCmd = process.platform === 'win32' ? 'start' : 'xdg-open';
      require('node:child_process').exec(`${openCmd} ${localUrl}`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const localUrl = `http://127.0.0.1:${port}`;
      console.log('============================================================');
      console.log(`⚡ IDM-RS is already running and active on ${localUrl}`);
      console.log('🌐 Opening Dashboard in your browser...');
      console.log('============================================================');
      if (autoOpen) {
        const openCmd = process.platform === 'win32' ? 'start' : 'xdg-open';
        require('node:child_process').exec(`${openCmd} ${localUrl}`);
      }
      return;
    }
    console.error('Server error:', err.message);
  });

  return server;
}

// -----------------------------------------------------------------------------
// Interactive CLI Downloader
// -----------------------------------------------------------------------------

async function runCliDownload(targetUrl, options = {}) {
  const downloadDir = options.dir || getDefaultDownloadDir();
  const connections = options.connections || 16;
  const quality = options.quality || '1080p';

  console.log('⚡ IDM-RS: Initializing multi-part turbo download...');
  console.log(`🔗 URL: ${targetUrl}`);
  console.log(`🚀 Threads: ${connections} | Quality: ${quality}`);

  const manager = new DownloadManager(downloadDir);
  const task = manager.addTask({
    url: targetUrl,
    fileName: options.output ? path.basename(options.output) : undefined,
    quality: quality,
    connections: connections,
    speedLimitBps: options.speedLimit || 0
  });

  const interval = setInterval(() => {
    const snap = task.getSnapshot();
    const pct = snap.progress_percent.toFixed(1);
    const speed = formatSpeed(snap.speed_bps);
    const downloaded = formatBytes(snap.downloaded_bytes);
    const total = snap.total_size > 0 ? formatBytes(snap.total_size) : 'Unknown';

    const barWidth = 30;
    const filled = Math.min(barWidth, Math.floor((snap.progress_percent / 100) * barWidth));
    const empty = barWidth - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);

    const statusMsg = snap.status === 'Muxing' ? '⚡ Muxing Audio & Video...' : `${speed}`;
    process.stdout.write(`\r[${bar}] ${pct}% | ${downloaded}/${total} | ${statusMsg} `);

    if (snap.status === 'Completed') {
      clearInterval(interval);
      console.log(`\n\n🎉 Download Complete! Saved to: ${snap.output_path}`);
      process.exit(0);
    } else if (snap.status === 'Failed') {
      clearInterval(interval);
      console.log(`\n\n❌ Download Failed: ${snap.error || 'Unknown error'}`);
      process.exit(1);
    }
  }, 250);
}

// -----------------------------------------------------------------------------
// Entry Point
// -----------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const manager = new DownloadManager();

  if (args.length === 0) {
    startServer(manager, PORT, true);
    return;
  }

  const cmd = args[0];

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`
⚡ IDM-RS: Ultra-Fast Dynamic Multi-Segment Internet Download Manager

USAGE:
    node idm.js                          Start Web Dashboard GUI & open browser
    node idm.js download <URL> [OPTIONS] High-speed accelerated CLI download
    node idm.js serve [OPTIONS]          Run background engine server
    node idm.js <URL>                    Quick download with default 16 connections

OPTIONS:
    -q, --quality <QUALITY>    Video Quality: 1080p, 720p, 480p, 360p, or audio
    -n, --connections <N>      Number of parallel connection threads (default: 16)
    -o, --output <PATH>        Output file name or destination path
    -p, --port <PORT>          Web server port (default: 8080)
    -d, --dir <PATH>           Download directory (default: ~/Downloads)
    --no-open                  Do not automatically open browser on startup
    `);
    return;
  }

  if (cmd === 'download' || cmd === 'd') {
    const targetUrl = args[1];
    if (!targetUrl) {
      console.error('Error: Missing download URL.');
      process.exit(1);
    }

    let connections = 16;
    let output = null;
    let quality = '1080p';

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '-n' || args[i] === '--connections') && args[i + 1]) {
        connections = parseInt(args[++i], 10);
      } else if ((args[i] === '-o' || args[i] === '--output') && args[i + 1]) {
        output = args[++i];
      } else if ((args[i] === '-q' || args[i] === '--quality') && args[i + 1]) {
        quality = args[++i];
      }
    }

    runCliDownload(targetUrl, { connections, output, quality });
    return;
  }

  if (cmd === 'serve' || cmd === 'gui') {
    let port = PORT;
    let autoOpen = true;

    for (let i = 1; i < args.length; i++) {
      if ((args[i] === '-p' || args[i] === '--port') && args[i + 1]) {
        port = parseInt(args[++i], 10);
      } else if (args[i] === '--no-open') {
        autoOpen = false;
      }
    }

    startServer(manager, port, autoOpen);
    return;
  }

  if (cmd.startsWith('http://') || cmd.startsWith('https://')) {
    runCliDownload(cmd, { connections: 16 });
    return;
  }

  console.error(`Unknown command: ${cmd}. Run "node idm.js --help" for help.`);
}

main();
