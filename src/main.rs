mod engine;
mod server;

use engine::downloader::TaskStatus;
use engine::DownloadManager;
use indicatif::{ProgressBar, ProgressStyle};
use std::path::PathBuf;
use std::time::Duration;
use tokio::time::sleep;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let args: Vec<String> = std::env::args().collect();
    let default_download_dir = dirs_or_current_dir();

    if args.len() == 1 {
        // Default: Launch Web Dashboard & open browser
        std::fs::create_dir_all(&default_download_dir)?;
        let manager = DownloadManager::new(default_download_dir);
        server::start_server(manager, 8080, true).await?;
        return Ok(());
    }

    match args[1].as_str() {
        "help" | "--help" | "-h" => {
            print_help();
        }
        "download" | "d" => {
            if args.len() < 3 {
                eprintln!("Error: Missing URL for download command.");
                eprintln!("Usage: idm-rs download <URL> [-n connections] [-o output] [--speed-limit bytes_per_sec]");
                std::process::exit(1);
            }
            let url = args[2].clone();
            let mut connections = 16;
            let mut output: Option<PathBuf> = None;
            let mut speed_limit = 0;

            let mut i = 3;
            while i < args.len() {
                match args[i].as_str() {
                    "-n" | "--connections" => {
                        if i + 1 < args.len() {
                            connections = args[i + 1].parse().unwrap_or(16);
                            i += 2;
                            continue;
                        }
                    }
                    "-o" | "--output" => {
                        if i + 1 < args.len() {
                            output = Some(PathBuf::from(&args[i + 1]));
                            i += 2;
                            continue;
                        }
                    }
                    "-s" | "--speed-limit" => {
                        if i + 1 < args.len() {
                            speed_limit = args[i + 1].parse().unwrap_or(0);
                            i += 2;
                            continue;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }

            run_cli_download(url, output, connections, speed_limit, default_download_dir).await?;
        }
        "serve" | "server" | "gui" => {
            let mut port = 8080;
            let mut dir: Option<PathBuf> = None;
            let mut no_open = false;

            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "-p" | "--port" => {
                        if i + 1 < args.len() {
                            port = args[i + 1].parse().unwrap_or(8080);
                            i += 2;
                            continue;
                        }
                    }
                    "-d" | "--dir" => {
                        if i + 1 < args.len() {
                            dir = Some(PathBuf::from(&args[i + 1]));
                            i += 2;
                            continue;
                        }
                    }
                    "--no-open" => {
                        no_open = true;
                    }
                    _ => {}
                }
                i += 1;
            }

            let target_dir = dir.unwrap_or(default_download_dir);
            std::fs::create_dir_all(&target_dir)?;
            let manager = DownloadManager::new(target_dir);
            server::start_server(manager, port, !no_open).await?;
        }
        url if url.starts_with("http://") || url.starts_with("https://") => {
            // Direct URL passed
            run_cli_download(url.to_string(), None, 16, 0, default_download_dir).await?;
        }
        cmd => {
            eprintln!("Unknown command: {}", cmd);
            print_help();
        }
    }

    Ok(())
}

fn print_help() {
    println!(r#"
⚡ IDM-RS: Ultra-Fast Dynamic Multi-Segment Internet Download Manager in Rust

USAGE:
    idm-rs                                  Start Web Dashboard GUI & open browser
    idm-rs download <URL> [OPTIONS]         High-speed accelerated CLI download
    idm-rs serve [OPTIONS]                  Run background engine server
    idm-rs <URL>                            Quick download with default 16 connections

OPTIONS for 'download':
    -n, --connections <N>      Number of parallel connection threads (default: 16)
    -o, --output <PATH>        Output destination file path or directory
    -s, --speed-limit <BYTES>  Speed limit in bytes/sec (0 = unlimited)

OPTIONS for 'serve':
    -p, --port <PORT>          Web server port (default: 8080)
    -d, --dir <PATH>           Download directory (default: ~/Downloads)
    --no-open                  Do not automatically open browser on startup
"#);
}

fn dirs_or_current_dir() -> PathBuf {
    if let Some(user_profile) = std::env::var_os("USERPROFILE") {
        let downloads = PathBuf::from(user_profile).join("Downloads");
        if downloads.exists() {
            return downloads;
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

async fn run_cli_download(
    url: String,
    output: Option<PathBuf>,
    connections: usize,
    speed_limit: u64,
    default_dir: PathBuf,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (target_dir, custom_filename) = if let Some(p) = output {
        if p.is_dir() {
            (p, None)
        } else {
            (
                p.parent().unwrap_or(&default_dir).to_path_buf(),
                Some(p.file_name().unwrap().to_string_lossy().to_string()),
            )
        }
    } else {
        (default_dir, None)
    };

    println!("⚡ IDM-RS: Initializing multi-part turbo download...");
    println!("🔗 URL: {}", url);
    println!("🚀 Threads: {}", connections);

    let manager = DownloadManager::new(target_dir);
    let task = manager
        .add_download(url, custom_filename, connections, speed_limit)
        .await;

    let pb = ProgressBar::new(100);
    pb.set_style(
        ProgressStyle::default_bar()
            .template("{spinner:.green} [{elapsed_precise}] [{bar:40.cyan/blue}] {bytes}/{total_bytes} ({percent}%) | ⚡ {msg} | ETA: {eta}")
            .unwrap()
            .progress_chars("━╸ "),
    );

    loop {
        sleep(Duration::from_millis(250)).await;
        let snap = task.get_snapshot().await;

        if snap.total_size > 0 {
            pb.set_length(snap.total_size);
            pb.set_position(snap.downloaded_bytes);
        }

        let speed_str = format_speed_bps(snap.speed_bps);
        pb.set_message(speed_str);

        match snap.status {
            TaskStatus::Completed => {
                pb.finish_with_message("Download Complete! ✅");
                println!("\n🎉 Successfully saved to: {}", snap.output_path);
                break;
            }
            TaskStatus::Failed => {
                pb.abandon_with_message("Download Failed! ❌");
                if let Some(err) = snap.error {
                    eprintln!("\nError details: {}", err);
                }
                break;
            }
            TaskStatus::Paused => {
                pb.set_message("Paused ⏸️");
                break;
            }
            _ => {}
        }
    }

    Ok(())
}

fn format_speed_bps(bps: u64) -> String {
    if bps >= 1024 * 1024 {
        format!("{:.2} MB/s", bps as f64 / (1024.0 * 1024.0))
    } else if bps >= 1024 {
        format!("{:.1} KB/s", bps as f64 / 1024.0)
    } else {
        format!("{} B/s", bps)
    }
}
