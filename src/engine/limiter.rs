use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::time::{sleep, Duration, Instant};

#[derive(Clone)]
pub struct RateLimiter {
    bytes_per_sec: Arc<AtomicU64>,
    window_start: Arc<tokio::sync::Mutex<Instant>>,
    bytes_in_window: Arc<AtomicU64>,
}

#[allow(dead_code)]
impl RateLimiter {
    pub fn new(bytes_per_sec: u64) -> Self {
        Self {
            bytes_per_sec: Arc::new(AtomicU64::new(bytes_per_sec)),
            window_start: Arc::new(tokio::sync::Mutex::new(Instant::now())),
            bytes_in_window: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn set_limit(&self, limit: u64) {
        self.bytes_per_sec.store(limit, Ordering::Relaxed);
    }

    pub async fn throttle(&self, bytes: usize) {
        let limit = self.bytes_per_sec.load(Ordering::Relaxed);
        if limit == 0 {
            return; // 0 means unlimited
        }

        let current = self.bytes_in_window.fetch_add(bytes as u64, Ordering::SeqCst) + (bytes as u64);
        if current >= limit {
            let mut start = self.window_start.lock().await;
            let elapsed = start.elapsed();
            if elapsed < Duration::from_secs(1) {
                let to_wait = Duration::from_secs(1) - elapsed;
                sleep(to_wait).await;
            }
            *start = Instant::now();
            self.bytes_in_window.store(0, Ordering::SeqCst);
        }
    }
}
