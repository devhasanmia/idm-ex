use super::segment::Segment;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadState {
    pub id: String,
    pub url: String,
    pub file_name: String,
    pub output_path: PathBuf,
    pub total_size: u64,
    pub supports_range: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub segments: Vec<Segment>,
    pub created_at: i64,
    pub updated_at: i64,
    pub speed_limit_bps: u64,
}

#[allow(dead_code)]
impl DownloadState {
    pub fn state_file_path(target_path: &Path) -> PathBuf {
        let mut p = target_path.to_path_buf();
        let new_name = format!("{}.idm.json", p.file_name().unwrap().to_string_lossy());
        p.set_file_name(new_name);
        p
    }

    pub async fn save_to_disk(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let path = Self::state_file_path(&self.output_path);
        let json = serde_json::to_string_pretty(self)?;
        fs::write(&path, json).await?;
        Ok(())
    }

    pub async fn load_from_disk(target_path: &Path) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let path = Self::state_file_path(target_path);
        let content = fs::read_to_string(&path).await?;
        let state: DownloadState = serde_json::from_str(&content)?;
        Ok(state)
    }

    pub async fn remove_state_file(target_path: &Path) {
        let path = Self::state_file_path(target_path);
        let _ = fs::remove_file(path).await;
    }

    pub fn total_downloaded(&self) -> u64 {
        self.segments.iter().map(|s| s.downloaded_bytes).sum()
    }

    pub fn is_all_completed(&self) -> bool {
        !self.segments.is_empty() && self.segments.iter().all(|s| s.is_completed())
    }

    pub fn progress_percent(&self) -> f64 {
        if self.total_size == 0 {
            0.0
        } else {
            (self.total_downloaded() as f64 / self.total_size as f64) * 100.0
        }
    }
}
