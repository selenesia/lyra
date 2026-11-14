use super::catalog::{self, Index, Parsed};
use super::Config;
use crate::{NEGATIVE, POSITIVE};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;

pub const INDEX_FILE: &str = "index.json";
const LOCK_FILE: &str = "sync.lock";
const LOCK_STALE: Duration = Duration::from_secs(6 * 60 * 60);
pub const MAX_ASSET_BYTES: usize = 48 * 1024 * 1024;
pub(super) const DOWNLOAD_CONCURRENCY: usize = 8;
const DOWNLOAD_ATTEMPTS: usize = 4;
const DOWNLOAD_MAX_FAILURES: usize = 40;

#[derive(Debug, PartialEq, Eq)]
pub enum FetchError {
    RateLimited(Duration),
    Status(u16),
    Invalid,
    TooLarge,
    Network,
    Storage,
}

impl FetchError {
    fn retryable(&self) -> bool {
        matches!(self, Self::RateLimited(_) | Self::Network) || matches!(self, Self::Status(status) if *status >= 500)
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    pub items: usize,
    pub assets: usize,
    pub downloaded: usize,
    pub failed: usize,
    pub missing: usize,
    pub bytes: u64,
    pub busy: bool,
}

struct SyncLock(PathBuf);

impl SyncLock {
    fn acquire(dir: &Path) -> std::io::Result<Option<Self>> {
        let path = dir.join(LOCK_FILE);
        for _ in 0..2 {
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    use std::io::Write;
                    let _ = write!(file, "{}", std::process::id());
                    return Ok(Some(Self(path)));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let owner_gone = cfg!(target_os = "linux")
                        && std::fs::read_to_string(&path)
                            .ok()
                            .and_then(|pid| pid.trim().parse::<u32>().ok())
                            .is_some_and(|pid| !Path::new(&format!("/proc/{pid}")).exists());
                    let stale = owner_gone
                        || std::fs::metadata(&path)
                            .and_then(|meta| meta.modified())
                            .map(|modified| modified.elapsed().unwrap_or_default() > LOCK_STALE)
                            .unwrap_or(true);
                    if !stale {
                        return Ok(None);
                    }
                    let _ = std::fs::remove_file(&path);
                }
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }
}

impl Drop for SyncLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub fn asset_path(dir: &Path, name: &str) -> PathBuf {
    dir.join("assets").join(&name[..2]).join(name)
}

pub fn read_index(dir: &Path) -> Option<Index> {
    let bytes = std::fs::read(dir.join(INDEX_FILE)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

async fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    tokio::fs::create_dir_all(parent).await?;
    let temporary = parent.join(format!(
        ".{}.{}.{}",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("file"),
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    if let Err(error) = tokio::fs::write(&temporary, bytes).await {
        let _ = tokio::fs::remove_file(&temporary).await;
        return Err(error);
    }
    match tokio::fs::rename(&temporary, path).await {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = tokio::fs::remove_file(&temporary).await;
            Err(error)
        }
    }
}

fn retry_after(headers: &reqwest::header::HeaderMap) -> Duration {
    let seconds = headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(5.0);
    Duration::from_millis((seconds.clamp(0.5, 300.0) * 1000.0) as u64)
}

pub fn matches_extension(bytes: &[u8], extension: &str) -> bool {
    match extension {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "webm" => bytes.starts_with(b"\x1a\x45\xdf\xa3"),
        _ => false,
    }
}

struct AssetDownload(PathBuf);

impl Drop for AssetDownload {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

pub async fn fetch_asset(client: &reqwest::Client, dir: &Path, name: &str, url: &str) -> Result<u64, FetchError> {
    let (_, extension) = catalog::split_asset_name(name).ok_or(FetchError::Invalid)?;
    let response = client
        .get(url)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .map_err(|_| FetchError::Network)?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(FetchError::RateLimited(retry_after(response.headers())));
    }
    if !status.is_success() {
        return Err(FetchError::Status(status.as_u16()));
    }
    if response.content_length().is_some_and(|length| length as usize > MAX_ASSET_BYTES) {
        return Err(FetchError::TooLarge);
    }
    store_asset(dir, name, extension, response.bytes_stream().map(|chunk| chunk.map_err(|_| FetchError::Network))).await
}

pub(super) async fn store_asset(
    dir: &Path,
    name: &str,
    extension: &str,
    mut chunks: impl futures_util::Stream<Item = Result<bytes::Bytes, FetchError>> + Unpin,
) -> Result<u64, FetchError> {
    let path = asset_path(dir, name);
    let parent = path.parent().ok_or(FetchError::Storage)?;
    tokio::fs::create_dir_all(parent).await.map_err(|_| FetchError::Storage)?;
    let temporary = AssetDownload(parent.join(format!(".{name}.{}", uuid::Uuid::new_v4().simple())));
    let mut file = tokio::fs::File::create(&temporary.0).await.map_err(|_| FetchError::Storage)?;
    let mut length = 0usize;
    let mut signature = Vec::with_capacity(8);
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        length = length.checked_add(chunk.len()).ok_or(FetchError::TooLarge)?;
        if length > MAX_ASSET_BYTES {
            return Err(FetchError::TooLarge);
        }
        if signature.len() < 8 {
            signature.extend_from_slice(&chunk[..chunk.len().min(8 - signature.len())]);
            if signature.len() == 8 && !matches_extension(&signature, extension) {
                return Err(FetchError::Invalid);
            }
        }
        file.write_all(&chunk).await.map_err(|_| FetchError::Storage)?;
    }
    if !matches_extension(&signature, extension) {
        return Err(FetchError::Invalid);
    }
    file.flush().await.map_err(|_| FetchError::Storage)?;
    drop(file);
    tokio::fs::rename(&temporary.0, &path).await.map_err(|_| FetchError::Storage)?;
    Ok(length as u64)
}

fn source_stamp(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    Some(format!("{}:{}:{modified}", catalog::PARSER_REVISION, meta.len()))
}

async fn read_source(config: &Config, previous: &Index, rebuild: bool) -> (Option<Parsed>, Option<String>) {
    let Some(path) = config.source.as_deref() else {
        return (None, previous.source_stamp.clone());
    };
    let Some(stamp) = source_stamp(path) else {
        tracing::warn!("cosmetics source is missing{NEGATIVE}");
        return (None, previous.source_stamp.clone());
    };
    if !rebuild && previous.source_stamp.as_deref() == Some(stamp.as_str()) {
        return (None, Some(stamp));
    }
    let path = path.to_owned();
    let parsed = tokio::task::spawn_blocking(move || {
        let bytes = std::fs::read(&path).ok()?;
        catalog::parse_export(&bytes).ok()
    })
    .await
    .ok()
    .flatten();
    match parsed {
        Some(parsed) => (Some(parsed), Some(stamp)),
        None => {
            tracing::warn!("cosmetics source could not be read{NEGATIVE}");
            (None, previous.source_stamp.clone())
        }
    }
}

fn missing_assets(dir: &Path, index: &Index) -> Vec<(String, String)> {
    catalog::referenced_names(&index.catalog)
        .into_iter()
        .filter_map(|name| {
            let (key, _) = catalog::split_asset_name(&name)?;
            let url = index.assets.get(key)?.clone();
            (!asset_path(dir, &name).exists()).then_some((name, url))
        })
        .collect()
}

async fn download_missing(client: &reqwest::Client, dir: &Path, index: &Index, report: &mut Report) {
    let missing = missing_assets(dir, index);
    if missing.is_empty() {
        return;
    }
    tracing::info!("cosmetics mirror: downloading {} assets", missing.len());
    let total = missing.len();
    let done = AtomicUsize::new(0);
    let failed = AtomicUsize::new(0);
    let streak = AtomicUsize::new(0);
    let bytes = AtomicU64::new(0);
    let pause_until = tokio::sync::Mutex::new(tokio::time::Instant::now());
    let started = tokio::time::Instant::now();
    futures_util::stream::iter(missing)
        .for_each_concurrent(DOWNLOAD_CONCURRENCY, |(name, url)| {
            let (done, failed, streak, bytes, pause_until) = (&done, &failed, &streak, &bytes, &pause_until);
            async move {
                if streak.load(Ordering::Relaxed) >= DOWNLOAD_MAX_FAILURES {
                    return;
                }
                let mut outcome = Err(FetchError::Network);
                for attempt in 0..DOWNLOAD_ATTEMPTS {
                    let wait = *pause_until.lock().await;
                    tokio::time::sleep_until(wait).await;
                    outcome = fetch_asset(client, dir, &name, &url).await;
                    match &outcome {
                        Err(FetchError::RateLimited(delay)) => {
                            let mut until = pause_until.lock().await;
                            *until = (*until).max(tokio::time::Instant::now() + *delay);
                        }
                        Err(error) if error.retryable() && attempt + 1 < DOWNLOAD_ATTEMPTS => {
                            tokio::time::sleep(Duration::from_secs(2 << attempt)).await;
                        }
                        _ => break,
                    }
                }
                match outcome {
                    Ok(size) => {
                        streak.store(0, Ordering::Relaxed);
                        bytes.fetch_add(size, Ordering::Relaxed);
                    }
                    Err(error) => {
                        failed.fetch_add(1, Ordering::Relaxed);
                        let count = streak.fetch_add(1, Ordering::Relaxed) + 1;
                        tracing::debug!(asset = %name, ?error, "cosmetic asset download failed{NEGATIVE}");
                        if count == DOWNLOAD_MAX_FAILURES {
                            tracing::warn!("cosmetics downloads keep failing, stopping this pass{NEGATIVE}");
                        }
                    }
                }
                let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                if finished % 250 == 0 || finished == total {
                    tracing::info!(
                        "cosmetics mirror: {finished}/{total} assets, {} mb, {}s",
                        bytes.load(Ordering::Relaxed) / (1024 * 1024),
                        started.elapsed().as_secs()
                    );
                }
            }
        })
        .await;
    report.failed += failed.load(Ordering::Relaxed);
    report.downloaded += done.load(Ordering::Relaxed).saturating_sub(failed.load(Ordering::Relaxed));
    report.bytes += bytes.load(Ordering::Relaxed);
}

pub async fn run(config: &Config, client: &reqwest::Client) -> std::io::Result<Report> {
    tokio::fs::create_dir_all(&config.dir).await?;
    let Some(_lock) = SyncLock::acquire(&config.dir)? else {
        tracing::info!("cosmetics sync is already running");
        return Ok(Report { busy: true, ..Report::default() });
    };
    let mut report = Report::default();
    let previous = read_index(&config.dir).unwrap_or_default();
    let fresh = previous.catalog.version.is_empty();
    let (source, stamp) = read_source(config, &previous, fresh).await;
    let mut index = catalog::build(&previous, source.into_iter().collect(), now_millis());
    index.source_stamp = stamp;
    let bytes = serde_json::to_vec(&index).map_err(std::io::Error::other)?;
    let current = tokio::fs::read(config.dir.join(INDEX_FILE)).await.ok();
    if current.as_deref() != Some(bytes.as_slice()) {
        write_atomic(&config.dir.join(INDEX_FILE), &bytes).await?;
    }
    let catalog = &index.catalog;
    report.items = catalog.decorations.len() + catalog.effects.len() + catalog.nameplates.len() + catalog.frames.len();
    report.assets = index.assets.len();
    if config.prefetch {
        download_missing(client, &config.dir, &index, &mut report).await;
        report.missing = missing_assets(&config.dir, &index).len();
    }
    if report.missing > 0 {
        tracing::warn!(
            "cosmetics sync left {} of {} assets undownloaded, they will be retried{NEGATIVE}",
            report.missing,
            report.assets
        );
    } else {
        tracing::info!(
            "cosmetics sync finished: {} items, {} assets, {} new{POSITIVE}",
            report.items,
            report.assets,
            report.downloaded
        );
    }
    Ok(report)
}
