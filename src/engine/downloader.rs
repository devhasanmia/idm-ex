use super::limiter::RateLimiter;
use super::segment::{create_initial_segments, Segment, SegmentStatus};
use super::state::DownloadState;
use super::writer::FileWriter;
use futures_util::StreamExt;
use reqwest::header::{HeaderMap, ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, RANGE, USER_AGENT};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use tokio::time::{sleep, Duration};

const MIN_SPLIT_SIZE: u64 = 2 * 1024 * 1024; // 2 MB minimum to split
const DEFAULT_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TaskStatus {
    Queued,
    Connecting,
    Downloading,
    Paused,
    Completed,
    Failed,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct TaskSnapshot {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub output_path: String,
    pub total_size: u64,
    pub downloaded_bytes: u64,
    pub speed_bps: u64,
    pub status: TaskStatus,
    pub progress_percent: f64,
    pub eta_seconds: Option<u64>,
    pub connections: usize,
    pub segments: Vec<Segment>,
    pub error: Option<String>,
}

pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub output_path: PathBuf,
    pub total_size: Arc<AtomicU64>,
    pub supports_range: Arc<AtomicBool>,
    pub segments: Arc<Mutex<Vec<Segment>>>,
    pub status: Arc<Mutex<TaskStatus>>,
    pub speed_bps: Arc<AtomicU64>,
    pub downloaded_bytes: Arc<AtomicU64>,
    pub rate_limiter: RateLimiter,
    pub cancel_notify: Arc<Notify>,
    pub client: Client,
    pub num_connections: usize,
    pub error_msg: Arc<Mutex<Option<String>>>,
}

impl DownloadTask {
    pub fn new(
        id: String,
        url: String,
        output_dir: &Path,
        custom_filename: Option<String>,
        connections: usize,
        speed_limit_bps: u64,
    ) -> Self {
        let inferred_filename = custom_filename.unwrap_or_else(|| Self::extract_filename_from_url(&url));
        let output_path = output_dir.join(&inferred_filename);

        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(32)
            .build()
            .unwrap_or_else(|_| Client::new());

        Self {
            id,
            url,
            file_name: inferred_filename,
            output_path,
            total_size: Arc::new(AtomicU64::new(0)),
            supports_range: Arc::new(AtomicBool::new(false)),
            segments: Arc::new(Mutex::new(Vec::new())),
            status: Arc::new(Mutex::new(TaskStatus::Queued)),
            speed_bps: Arc::new(AtomicU64::new(0)),
            downloaded_bytes: Arc::new(AtomicU64::new(0)),
            rate_limiter: RateLimiter::new(speed_limit_bps),
            cancel_notify: Arc::new(Notify::new()),
            client,
            num_connections: connections.clamp(1, 64),
            error_msg: Arc::new(Mutex::new(None)),
        }
    }

    pub fn extract_filename_from_url(url: &str) -> String {
        if let Ok(parsed) = url::Url::parse(url) {
            if let Some(mut segments) = parsed.path_segments() {
                if let Some(last) = segments.next_back() {
                    let cleaned = last.trim();
                    if !cleaned.is_empty() {
                        return sanitize_filename(cleaned);
                    }
                }
            }
        }
        format!("download_{}", chrono::Utc::now().timestamp())
    }

    pub async fn get_snapshot(&self) -> TaskSnapshot {
        let status = *self.status.lock().await;
        let total = self.total_size.load(Ordering::Relaxed);
        let downloaded = self.downloaded_bytes.load(Ordering::Relaxed);
        let speed = self.speed_bps.load(Ordering::Relaxed);
        let segments = self.segments.lock().await.clone();
        let error = self.error_msg.lock().await.clone();

        let progress = if total > 0 {
            (downloaded as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
        } else {
            0.0
        };

        let eta_seconds = if speed > 0 && total > downloaded {
            Some((total - downloaded) / speed)
        } else {
            None
        };

        TaskSnapshot {
            id: self.id.clone(),
            url: self.url.clone(),
            file_name: self.file_name.clone(),
            output_path: self.output_path.to_string_lossy().to_string(),
            total_size: total,
            downloaded_bytes: downloaded,
            speed_bps: speed,
            status,
            progress_percent: progress,
            eta_seconds,
            connections: self.num_connections,
            segments,
            error,
        }
    }

    pub async fn start(self: Arc<Self>) {
        tokio::spawn(async move {
            if let Err(e) = self.run_download().await {
                *self.status.lock().await = TaskStatus::Failed;
                *self.error_msg.lock().await = Some(e.to_string());
                self.speed_bps.store(0, Ordering::Relaxed);
            }
        });
    }

    pub async fn pause(&self) {
        let mut status = self.status.lock().await;
        if *status == TaskStatus::Downloading || *status == TaskStatus::Connecting {
            *status = TaskStatus::Paused;
            self.cancel_notify.notify_waiters();
            self.speed_bps.store(0, Ordering::Relaxed);
        }
    }

    pub async fn cancel(&self) {
        let mut status = self.status.lock().await;
        *status = TaskStatus::Failed;
        *self.error_msg.lock().await = Some("Cancelled by user".to_string());
        self.cancel_notify.notify_waiters();
        self.speed_bps.store(0, Ordering::Relaxed);
    }

    async fn probe_server(&self) -> Result<(u64, bool, Option<String>), Box<dyn std::error::Error + Send + Sync>> {
        // Try HEAD first
        let head_res = self
            .client
            .head(&self.url)
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .send()
            .await;

        if let Ok(res) = head_res {
            if res.status().is_success() {
                let headers = res.headers();
                let total_len = headers
                    .get(CONTENT_LENGTH)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.parse::<u64>().ok())
                    .unwrap_or(0);

                let supports_range = headers
                    .get(ACCEPT_RANGES)
                    .and_then(|v| v.to_str().ok())
                    .map(|v| v.to_lowercase().contains("bytes"))
                    .unwrap_or(false);

                let filename = parse_content_disposition(headers);
                if total_len > 0 {
                    return Ok((total_len, supports_range, filename));
                }
            }
        }

        // Fallback: Range probe with GET bytes=0-0
        let range_res = self
            .client
            .get(&self.url)
            .header(USER_AGENT, DEFAULT_USER_AGENT)
            .header(RANGE, "bytes=0-0")
            .send()
            .await?;

        let headers = range_res.headers();
        let status = range_res.status();

        let mut supports_range = status.as_u16() == 206;
        let mut total_len = 0;

        if let Some(cr) = headers.get(CONTENT_RANGE).and_then(|v| v.to_str().ok()) {
            supports_range = true;
            if let Some(pos) = cr.rfind('/') {
                let total_str = &cr[pos + 1..].trim();
                if let Ok(sz) = total_str.parse::<u64>() {
                    total_len = sz;
                }
            }
        }

        if total_len == 0 {
            if let Some(cl) = headers.get(CONTENT_LENGTH).and_then(|v| v.to_str().ok()) {
                if let Ok(sz) = cl.parse::<u64>() {
                    if status.as_u16() == 200 {
                        total_len = sz;
                    }
                }
            }
        }

        let filename = parse_content_disposition(headers);
        Ok((total_len, supports_range, filename))
    }

    async fn run_download(self: &Arc<Self>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        *self.status.lock().await = TaskStatus::Connecting;

        // Check if there is an existing state file to resume
        let mut loaded_state: Option<DownloadState> = None;
        if self.output_path.exists() {
            if let Ok(st) = DownloadState::load_from_disk(&self.output_path).await {
                if st.url == self.url && st.total_size > 0 {
                    loaded_state = Some(st);
                }
            }
        }

        let (total_len, supports_range) = if let Some(ref st) = loaded_state {
            (st.total_size, st.supports_range)
        } else {
            let (len, range, maybe_name) = self.probe_server().await?;
            if let Some(_name) = maybe_name {
                // filename update if server specified one
                // handled gracefully
            }
            (len, range)
        };

        self.total_size.store(total_len, Ordering::Relaxed);
        self.supports_range.store(supports_range, Ordering::Relaxed);

        // Prepare segments
        let initial_segments = if let Some(st) = loaded_state {
            let downloaded: u64 = st.segments.iter().map(|s| s.downloaded_bytes).sum();
            self.downloaded_bytes.store(downloaded, Ordering::Relaxed);
            st.segments
        } else if supports_range && total_len > 0 {
            create_initial_segments(total_len, self.num_connections)
        } else {
            // Single stream fallback
            vec![Segment::new(0, 0, if total_len > 0 { total_len - 1 } else { 0 })]
        };

        {
            let mut segs = self.segments.lock().await;
            *segs = initial_segments;
        }

        *self.status.lock().await = TaskStatus::Downloading;

        // Initialize Direct File Writer
        let (file_writer, writer_handle, receiver) = FileWriter::new(self.output_path.clone(), total_len);
        let writer_join = tokio::spawn(async move {
            file_writer.run_writer(receiver).await
        });

        // Launch Speed & Persistence Monitor
        let monitor_self = Arc::clone(self);
        let monitor_join = tokio::spawn(async move {
            let mut last_downloaded = monitor_self.downloaded_bytes.load(Ordering::Relaxed);
            let mut ticker = tokio::time::interval(Duration::from_millis(500));
            loop {
                ticker.tick().await;
                let current_status = *monitor_self.status.lock().await;
                if current_status != TaskStatus::Downloading {
                    break;
                }

                let current_downloaded = monitor_self.downloaded_bytes.load(Ordering::Relaxed);
                let diff = current_downloaded.saturating_sub(last_downloaded);
                let speed = diff * 2; // per second
                monitor_self.speed_bps.store(speed, Ordering::Relaxed);
                last_downloaded = current_downloaded;

                // Save state snapshot
                let segs = monitor_self.segments.lock().await.clone();
                let state = DownloadState {
                    id: monitor_self.id.clone(),
                    url: monitor_self.url.clone(),
                    file_name: monitor_self.file_name.clone(),
                    output_path: monitor_self.output_path.clone(),
                    total_size: monitor_self.total_size.load(Ordering::Relaxed),
                    supports_range: monitor_self.supports_range.load(Ordering::Relaxed),
                    etag: None,
                    last_modified: None,
                    segments: segs,
                    created_at: 0,
                    updated_at: chrono::Utc::now().timestamp(),
                    speed_limit_bps: 0,
                };
                let _ = state.save_to_disk().await;
            }
        });

        // Concurrency Workers Controller (Dynamic Multi-Part Segmentation Engine)
        let mut worker_handles = Vec::new();
        let num_workers = if supports_range && total_len > 0 {
            self.num_connections
        } else {
            1
        };

        for worker_id in 0..num_workers {
            let task = Arc::clone(self);
            let handle = writer_handle.clone();
            let handle_spawn = tokio::spawn(async move {
                task.run_segment_worker(worker_id, handle).await
            });
            worker_handles.push(handle_spawn);
        }

        // Wait for all workers to complete or cancel
        for h in worker_handles {
            let _ = h.await;
        }

        drop(writer_handle); // close channel to file writer
        let _ = writer_join.await;
        let _ = monitor_join.await;

        let status = *self.status.lock().await;
        if status == TaskStatus::Downloading {
            let downloaded = self.downloaded_bytes.load(Ordering::Relaxed);
            if total_len == 0 || downloaded >= total_len {
                *self.status.lock().await = TaskStatus::Completed;
                self.speed_bps.store(0, Ordering::Relaxed);
                DownloadState::remove_state_file(&self.output_path).await;
            }
        }

        Ok(())
    }

    async fn run_segment_worker(
        self: Arc<Self>,
        _worker_id: usize,
        writer: super::writer::FileWriterHandle,
    ) {
        loop {
            // Check status or cancellation
            if *self.status.lock().await != TaskStatus::Downloading {
                break;
            }

            // Acquire next segment to work on, or split an existing large one (IDM Dynamic Segmentation)
            let maybe_segment_idx = {
                let mut segs = self.segments.lock().await;
                // 1. First priority: any pending segment that hasn't started
                let pending = segs.iter().position(|s| s.status == SegmentStatus::Pending);
                if pending.is_some() {
                    pending
                } else if self.supports_range.load(Ordering::Relaxed) {
                    // 2. IDM Dynamic Segment Splitting: find the active segment with the largest remaining bytes
                    let mut max_rem = 0;
                    let mut max_idx = None;
                    for (i, s) in segs.iter().enumerate() {
                        if s.status == SegmentStatus::Downloading {
                            let rem = s.remaining_bytes();
                            if rem > max_rem && rem >= MIN_SPLIT_SIZE * 2 {
                                max_rem = rem;
                                max_idx = Some(i);
                            }
                        }
                    }

                    if let Some(target_idx) = max_idx {
                        let new_id = segs.len();
                        if let Some(new_seg) = segs[target_idx].split(new_id, MIN_SPLIT_SIZE) {
                            segs.push(new_seg);
                            Some(new_id)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            };

            let seg_idx = match maybe_segment_idx {
                Some(idx) => idx,
                None => {
                    // No more segments to download or split. Worker can safely exit.
                    break;
                }
            };

            // Mark segment as downloading
            {
                let mut segs = self.segments.lock().await;
                segs[seg_idx].status = SegmentStatus::Downloading;
            }

            // Download segment range
            let res = self.download_segment_stream(seg_idx, &writer).await;

            let mut segs = self.segments.lock().await;
            match res {
                Ok(true) => {
                    segs[seg_idx].status = SegmentStatus::Completed;
                }
                Ok(false) => {
                    // Stopped because paused/cancelled
                    segs[seg_idx].status = SegmentStatus::Paused;
                    break;
                }
                Err(_e) => {
                    // Mark as failed or pending to retry
                    segs[seg_idx].status = SegmentStatus::Pending;
                    sleep(Duration::from_millis(500)).await;
                }
            }
        }
    }

    async fn download_segment_stream(
        self: &Arc<Self>,
        seg_idx: usize,
        writer: &super::writer::FileWriterHandle,
    ) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
        let (start, end, downloaded_so_far) = {
            let segs = self.segments.lock().await;
            let s = &segs[seg_idx];
            (s.start_byte, s.end_byte, s.downloaded_bytes)
        };

        let current_pos = start + downloaded_so_far;
        if current_pos > end && end > 0 {
            return Ok(true);
        }

        let mut req = self.client.get(&self.url).header(USER_AGENT, DEFAULT_USER_AGENT);

        if self.supports_range.load(Ordering::Relaxed) {
            let range_header = if end > 0 {
                format!("bytes={}-{}", current_pos, end)
            } else {
                format!("bytes={}-", current_pos)
            };
            req = req.header(RANGE, range_header);
        }

        let res = req.send().await?;
        if !res.status().is_success() {
            return Err(format!("Server returned HTTP {}", res.status()).into());
        }

        let mut stream = res.bytes_stream();

        while let Some(chunk_res) = stream.next().await {
            // Check for pause/cancellation
            if *self.status.lock().await != TaskStatus::Downloading {
                return Ok(false);
            }

            let chunk = chunk_res?;
            let len = chunk.len();
            if len == 0 {
                continue;
            }

            self.rate_limiter.throttle(len).await;

            let write_offset = {
                let mut segs = self.segments.lock().await;
                let s = &mut segs[seg_idx];
                let offset = s.start_byte + s.downloaded_bytes;
                s.downloaded_bytes += len as u64;
                offset
            };

            writer.write(write_offset, chunk.to_vec()).await?;
            self.downloaded_bytes.fetch_add(len as u64, Ordering::Relaxed);
        }

        Ok(true)
    }
}

fn parse_content_disposition(headers: &HeaderMap) -> Option<String> {
    if let Some(val) = headers.get(CONTENT_DISPOSITION).and_then(|v| v.to_str().ok()) {
        if let Some(pos) = val.find("filename=") {
            let raw = &val[pos + 9..].trim();
            let trimmed = raw.trim_matches('"').trim_matches('\'');
            if let Some(end) = trimmed.find(';') {
                return Some(sanitize_filename(&trimmed[..end]));
            }
            return Some(sanitize_filename(trimmed));
        }
    }
    None
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if c == '/' || c == '\\' || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|' {
            out.push('_');
        } else {
            out.push(c);
        }
    }
    let res = out.trim().to_string();
    if res.is_empty() {
        format!("file_{}", chrono::Utc::now().timestamp())
    } else {
        res
    }
}
