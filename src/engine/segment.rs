use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SegmentStatus {
    Pending,
    Downloading,
    Completed,
    Failed,
    Paused,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub id: usize,
    pub start_byte: u64,
    pub end_byte: u64, // inclusive
    pub downloaded_bytes: u64,
    pub status: SegmentStatus,
    #[serde(skip)]
    pub current_speed_bps: u64,
}

#[allow(dead_code)]
impl Segment {
    pub fn new(id: usize, start: u64, end: u64) -> Self {
        Self {
            id,
            start_byte: start,
            end_byte: end,
            downloaded_bytes: 0,
            status: SegmentStatus::Pending,
            current_speed_bps: 0,
        }
    }

    pub fn total_bytes(&self) -> u64 {
        if self.end_byte >= self.start_byte {
            self.end_byte - self.start_byte + 1
        } else {
            0
        }
    }

    pub fn remaining_bytes(&self) -> u64 {
        let total = self.total_bytes();
        if self.downloaded_bytes >= total {
            0
        } else {
            total - self.downloaded_bytes
        }
    }

    pub fn current_pos(&self) -> u64 {
        self.start_byte + self.downloaded_bytes
    }

    pub fn is_completed(&self) -> bool {
        self.downloaded_bytes >= self.total_bytes()
    }

    pub fn progress_ratio(&self) -> f64 {
        let total = self.total_bytes();
        if total == 0 {
            1.0
        } else {
            (self.downloaded_bytes as f64) / (total as f64)
        }
    }

    /// Split this segment dynamically if it has enough remaining bytes
    /// IDM Dynamic Segmentation: split remaining bytes in half
    pub fn split(&mut self, new_id: usize, min_chunk_size: u64) -> Option<Segment> {
        let rem = self.remaining_bytes();
        if rem < min_chunk_size * 2 {
            return None;
        }

        let current_head = self.current_pos();
        let half = rem / 2;
        let new_seg_start = current_head + half;
        let original_end = self.end_byte;

        // Shrink current segment's end to right before new segment
        self.end_byte = new_seg_start - 1;

        // Create new segment covering the remaining half
        Some(Segment::new(new_id, new_seg_start, original_end))
    }
}

pub fn create_initial_segments(total_size: u64, count: usize) -> Vec<Segment> {
    if total_size == 0 || count <= 1 {
        return vec![Segment::new(0, 0, if total_size > 0 { total_size - 1 } else { 0 })];
    }

    let count = count.max(1);
    let chunk_size = total_size / (count as u64);
    let mut segments = Vec::with_capacity(count);

    let mut start = 0;
    for i in 0..count {
        let end = if i == count - 1 {
            total_size - 1
        } else {
            start + chunk_size - 1
        };

        segments.push(Segment::new(i, start, end));
        start = end + 1;
    }

    segments
}
