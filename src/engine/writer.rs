use std::path::PathBuf;
use tokio::fs::OpenOptions;
use tokio::io::{AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::mpsc::{self, Receiver, Sender};

pub struct WriteChunk {
    pub offset: u64,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub struct FileWriterHandle {
    sender: Sender<WriteChunk>,
}

impl FileWriterHandle {
    pub async fn write(&self, offset: u64, data: Vec<u8>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        self.sender
            .send(WriteChunk { offset, data })
            .await
            .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?;
        Ok(())
    }
}

pub struct FileWriter {
    file_path: PathBuf,
    total_size: u64,
}

impl FileWriter {
    pub fn new(file_path: PathBuf, total_size: u64) -> (Self, FileWriterHandle, Receiver<WriteChunk>) {
        let (sender, receiver) = mpsc::channel(256);
        (
            Self {
                file_path,
                total_size,
            },
            FileWriterHandle { sender },
            receiver,
        )
    }

    pub async fn run_writer(
        self,
        mut receiver: Receiver<WriteChunk>,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.file_path)
            .await?;

        if self.total_size > 0 {
            let current_len = file.metadata().await?.len();
            if current_len < self.total_size {
                file.set_len(self.total_size).await?;
            }
        }

        while let Some(chunk) = receiver.recv().await {
            file.seek(SeekFrom::Start(chunk.offset)).await?;
            file.write_all(&chunk.data).await?;
        }

        file.flush().await?;
        file.sync_all().await?;
        Ok(())
    }
}
