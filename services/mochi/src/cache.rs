use crate::helpers::fix_game_content_type;
use crate::state::CachedResponse;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use sha2::{Digest, Sha256};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, SystemTime};
use tokio::fs::{self, File};
use tokio::io::{
    self, AsyncRead, AsyncReadExt, AsyncSeekExt, AsyncWrite, AsyncWriteExt, BufReader, BufWriter,
};
use tokio_util::io::ReaderStream;

const MAX_CACHED_HEADERS: u16 = 256;
const MAX_HEADER_NAME_LEN: usize = 128;
const MAX_HEADER_VALUE_LEN: usize = 32 * 1024;
const DISK_CHUNK_BYTES: usize = 256 * 1024;
const DISK_TOUCH_INTERVAL: Duration = Duration::from_secs(10 * 60);

static DISK_TOUCHES: LazyLock<moka::future::Cache<String, ()>> = LazyLock::new(|| {
    moka::future::Cache::builder()
        .time_to_live(DISK_TOUCH_INTERVAL)
        .max_capacity(50_000)
        .build()
});

pub(crate) fn touch_cache_file(path: String) {
    if DISK_TOUCHES.contains_key(&path) {
        return;
    }
    tokio::spawn(async move {
        DISK_TOUCHES.insert(path.clone(), ()).await;
        let _ = tokio::task::spawn_blocking(move || {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .and_then(|file| file.set_modified(SystemTime::now()))
        })
        .await;
    });
}

pub fn disk_writer(file: File) -> BufWriter<File> {
    BufWriter::with_capacity(DISK_CHUNK_BYTES, file)
}

pub(crate) fn freshness_lifetime(headers: &HeaderMap, shared: bool, limit: u64) -> Option<u64> {
    let mut max_age = None;
    let mut shared_age = None;
    for value in headers.get_all("cache-control") {
        for directive in value.to_str().ok()?.split(',') {
            let (name, value) = directive
                .trim()
                .split_once('=')
                .unwrap_or((directive.trim(), ""));
            let name = name.trim();
            if name.eq_ignore_ascii_case("no-store") || name.eq_ignore_ascii_case("no-cache") {
                return None;
            }
            let slot = if name.eq_ignore_ascii_case("max-age") {
                &mut max_age
            } else if name.eq_ignore_ascii_case("s-maxage") {
                &mut shared_age
            } else {
                continue;
            };
            if slot.is_some() {
                return None;
            }
            *slot = Some(value.trim().trim_matches('"').parse::<u64>().ok()?);
        }
    }
    let lifetime = (if shared {
        shared_age.or(max_age)
    } else {
        max_age
    })
    .or_else(|| {
        let expires = httpdate::parse_http_date(headers.get("expires")?.to_str().ok()?).ok()?;
        let date = httpdate::parse_http_date(headers.get("date")?.to_str().ok()?).ok()?;
        Some(expires.duration_since(date).unwrap_or_default().as_secs())
    })?;
    Some(lifetime.min(limit))
}

pub(crate) fn response_age(
    headers: &HeaderMap,
    now: SystemTime,
    delay: Duration,
) -> Option<Duration> {
    if headers.get_all("age").iter().count() > 1 || headers.get_all("date").iter().count() > 1 {
        return None;
    }
    let age = match headers.get("age") {
        Some(value) => Duration::from_secs(value.to_str().ok()?.parse::<u64>().ok()?),
        None => Duration::ZERO,
    };
    let apparent = match headers.get("date") {
        Some(value) => now
            .duration_since(httpdate::parse_http_date(value.to_str().ok()?).ok()?)
            .unwrap_or_default(),
        None => Duration::ZERO,
    };
    Some(apparent.max(age.saturating_add(delay)))
}

pub(crate) fn request_bypasses_cache(headers: &HeaderMap) -> bool {
    [
        "if-range",
        "if-none-match",
        "if-modified-since",
        "if-match",
        "if-unmodified-since",
    ]
    .iter()
    .any(|name| headers.contains_key(*name))
        || headers.get_all("cache-control").iter().any(|value| {
            value.to_str().map_or(true, |value| {
                value.split(',').any(|directive| {
                    let (name, _) = directive
                        .trim()
                        .split_once('=')
                        .unwrap_or((directive.trim(), ""));
                    ["no-cache", "no-store", "max-age", "min-fresh"]
                        .iter()
                        .any(|candidate| name.trim().eq_ignore_ascii_case(candidate))
                })
            })
        })
        || headers.get_all("pragma").iter().any(|value| {
            value.to_str().map_or(true, |value| {
                value
                    .split(',')
                    .any(|v| v.trim().eq_ignore_ascii_case("no-cache"))
            })
        })
}

pub(crate) fn stream_cache_fresh(headers: &HeaderMap) -> bool {
    headers.contains_key("date")
        && freshness_lifetime(headers, true, u64::MAX)
            .zip(response_age(headers, SystemTime::now(), Duration::ZERO))
            .is_some_and(|(lifetime, age)| age < Duration::from_secs(lifetime))
}

fn get_cache_path_in(directory: &str, url: &str) -> String {
    let hash = Sha256::digest(url.as_bytes());
    format!("{directory}/{}.bin", hex::encode(&hash[..16]))
}

pub fn get_cache_path(url: &str) -> String {
    get_cache_path_in("./cache", &format!("assets-v2\n{url}"))
}

pub fn get_stream_cache_path(url: &str) -> String {
    get_cache_path_in("./cache/stream", url)
}

async fn read_cache_header<R>(reader: &mut R) -> Option<(u16, HeaderMap)>
where
    R: AsyncRead + Unpin,
{
    let mut buf_u16 = [0u8; 2];
    reader.read_exact(&mut buf_u16).await.ok()?;
    let status_code = u16::from_le_bytes(buf_u16);

    reader.read_exact(&mut buf_u16).await.ok()?;
    let header_count = u16::from_le_bytes(buf_u16);
    if header_count > MAX_CACHED_HEADERS {
        return None;
    }

    let mut headers = HeaderMap::new();
    for _ in 0..header_count {
        reader.read_exact(&mut buf_u16).await.ok()?;
        let k_len = u16::from_le_bytes(buf_u16) as usize;
        if k_len == 0 || k_len > MAX_HEADER_NAME_LEN {
            return None;
        }
        let mut k_buf = vec![0u8; k_len];
        reader.read_exact(&mut k_buf).await.ok()?;
        let key_str = String::from_utf8(k_buf).ok()?;

        let mut buf_u32 = [0u8; 4];
        reader.read_exact(&mut buf_u32).await.ok()?;
        let v_len = u32::from_le_bytes(buf_u32) as usize;
        if v_len > MAX_HEADER_VALUE_LEN {
            return None;
        }
        let mut v_buf = vec![0u8; v_len];
        reader.read_exact(&mut v_buf).await.ok()?;

        let h_name = axum::http::header::HeaderName::from_bytes(key_str.as_bytes()).ok()?;
        let h_val = axum::http::header::HeaderValue::from_bytes(&v_buf).ok()?;
        headers.append(h_name, h_val);
    }
    if status_code != 200
        || headers.contains_key("content-range")
        || headers.contains_key("set-cookie")
    {
        return None;
    }
    Some((status_code, headers))
}

fn cache_header_len(headers: &HeaderMap) -> u64 {
    headers.iter().fold(4, |len, (name, value)| {
        len + 6 + name.as_str().len() as u64 + value.len() as u64
    })
}

pub async fn load_from_disk(
    url: &str,
    max_entry_size: usize,
    max_age_secs: u64,
    buffer_limit: usize,
) -> Option<(Response, Option<Arc<CachedResponse>>)> {
    let path = get_cache_path(url);
    let file = File::open(&path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    let idle = metadata.modified().ok()?.elapsed().ok()?;
    if metadata.len() > max_entry_size.saturating_add(64 * 1024) as u64
        || idle.as_secs() > max_age_secs
    {
        return None;
    }
    let mut reader = BufReader::new(file);

    let (status_code, mut headers) = read_cache_header(&mut reader).await?;
    if !stream_cache_fresh(&headers) || !crate::proxy::response_allows_shared_cache(&headers) {
        return None;
    }
    if idle >= DISK_TOUCH_INTERVAL {
        touch_cache_file(path);
    }
    let body_len = metadata.len().checked_sub(cache_header_len(&headers))?;
    fix_game_content_type(url, &mut headers);
    let status = StatusCode::from_u16(status_code).unwrap_or(StatusCode::OK);

    if body_len <= buffer_limit as u64 {
        let mut body = Vec::with_capacity(body_len as usize);
        reader.read_to_end(&mut body).await.ok()?;
        if body.len() as u64 != body_len {
            return None;
        }
        let cached = Arc::new(CachedResponse {
            status: status_code,
            headers: headers.clone(),
            body: Bytes::from(body),
        });
        headers.insert("X-Cache", HeaderValue::from_static("DISK"));
        let response = (status, headers, cached.body.clone()).into_response();
        return Some((response, Some(cached)));
    }

    headers.insert("X-Cache", HeaderValue::from_static("DISK"));
    let stream = ReaderStream::with_capacity(reader, DISK_CHUNK_BYTES);
    let body = Body::from_stream(stream);
    Some(((status, headers, body).into_response(), None))
}

pub struct StreamDiskEntry {
    pub status: u16,
    pub headers: HeaderMap,
    pub reader: BufReader<File>,
    pub body_offset: u64,
    pub body_len: u64,
}

pub async fn load_stream_from_disk(
    cache_key: &str,
    max_entry_size: usize,
    max_age_secs: u64,
) -> Option<StreamDiskEntry> {
    let path = get_stream_cache_path(cache_key);
    let file = File::open(&path).await.ok()?;
    let metadata = file.metadata().await.ok()?;
    let idle = metadata.modified().ok()?.elapsed().ok()?;
    if metadata.len() > max_entry_size.saturating_add(64 * 1024) as u64
        || idle.as_secs() > max_age_secs
    {
        return None;
    }
    let mut reader = BufReader::new(file);
    let (status, mut headers) = read_cache_header(&mut reader).await?;
    if !stream_cache_fresh(&headers) {
        return None;
    }
    if idle >= DISK_TOUCH_INTERVAL {
        touch_cache_file(path);
    }
    let body_offset = reader.stream_position().await.ok()?;
    let body_len = metadata.len().checked_sub(body_offset)?;
    if body_len > max_entry_size as u64 {
        return None;
    }

    if let Some(recorded_len) = headers.get(axum::http::header::CONTENT_LENGTH) {
        if recorded_len.to_str().ok()?.parse::<u64>().ok()? != body_len {
            return None;
        }
    } else {
        headers.insert(
            axum::http::header::CONTENT_LENGTH,
            HeaderValue::from_str(&body_len.to_string()).ok()?,
        );
    }

    Some(StreamDiskEntry {
        status,
        headers,
        reader,
        body_offset,
        body_len,
    })
}

pub async fn write_cache_header<W>(
    writer: &mut W,
    status: u16,
    headers: &HeaderMap,
) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    if status != 200 || headers.contains_key("content-range") || headers.contains_key("set-cookie")
    {
        return Err(io::Error::other(
            "response is not a complete shared cache entry... /ᐠ - ˕ -マ",
        ));
    }
    let header_count = u16::try_from(headers.len()).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "too many headers... /ᐠ - ˕ -マ",
        )
    })?;

    writer.write_all(&status.to_le_bytes()).await?;
    writer.write_all(&header_count.to_le_bytes()).await?;

    for (k, v) in headers.iter() {
        let k_bytes = k.as_str().as_bytes();
        let k_len = u16::try_from(k_bytes.len()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "header name is too long... /ᐠ - ˕ -マ",
            )
        })?;
        writer.write_all(&k_len.to_le_bytes()).await?;
        writer.write_all(k_bytes).await?;

        let v_bytes = v.as_bytes();
        let v_len = u32::try_from(v_bytes.len()).map_err(|_| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "header value is too long... /ᐠ - ˕ -マ",
            )
        })?;
        writer.write_all(&v_len.to_le_bytes()).await?;
        writer.write_all(v_bytes).await?;
    }

    Ok(())
}

async fn write_to_disk_path(cache_path: String, status: u16, headers: &HeaderMap, body: &Bytes) {
    let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());
    let Ok(f) = File::create(&temp_path).await else {
        return;
    };
    let mut f = disk_writer(f);

    if write_cache_header(&mut f, status, headers).await.is_err() {
        let _ = fs::remove_file(&temp_path).await;
        return;
    }

    if f.write_all(body).await.is_err() {
        let _ = fs::remove_file(&temp_path).await;
        return;
    }
    if f.flush().await.is_err() {
        let _ = fs::remove_file(&temp_path).await;
        return;
    }
    drop(f);
    let _ = fs::rename(&temp_path, &cache_path).await;
}

pub async fn write_to_disk(cache_key: &str, status: u16, headers: &HeaderMap, body: &Bytes) {
    write_to_disk_path(get_cache_path(cache_key), status, headers, body).await;
}

type PendingWrite = tokio::task::JoinHandle<io::Result<std::fs::File>>;

pub struct StreamCacheWriter {
    cache_path: String,
    temp_path: String,
    file: Option<std::fs::File>,
    in_flight: Option<PendingWrite>,
    pending: Vec<Bytes>,
    pending_len: usize,
    published: bool,
}

fn closed_stream_writer() -> io::Error {
    io::Error::new(
        io::ErrorKind::BrokenPipe,
        "stream cache writer is closed... /ᐠ - ˕ -マ",
    )
}

fn write_all_chunks(file: &mut std::fs::File, chunks: &[Bytes]) -> io::Result<()> {
    use std::io::{IoSlice, Write};
    let mut slices: Vec<IoSlice<'_>> = chunks
        .iter()
        .filter(|chunk| !chunk.is_empty())
        .map(|chunk| IoSlice::new(chunk))
        .collect();
    let mut remaining = slices.as_mut_slice();
    while !remaining.is_empty() {
        match file.write_vectored(remaining) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(written) => IoSlice::advance_slices(&mut remaining, written),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

impl StreamCacheWriter {
    pub async fn create(cache_key: &str, status: u16, headers: &HeaderMap) -> io::Result<Self> {
        let mut header = Vec::with_capacity(cache_header_len(headers) as usize);
        write_cache_header(&mut header, status, headers).await?;
        let cache_path = get_stream_cache_path(cache_key);
        let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());
        let file = File::create(&temp_path).await?.into_std().await;
        Ok(Self {
            cache_path,
            temp_path,
            file: Some(file),
            in_flight: None,
            pending_len: header.len(),
            pending: vec![Bytes::from(header)],
            published: false,
        })
    }

    async fn take_file(&mut self) -> io::Result<std::fs::File> {
        match self.in_flight.take() {
            Some(write) => write.await.map_err(io::Error::other)?,
            None => self.file.take().ok_or_else(closed_stream_writer),
        }
    }

    async fn write_pending(&mut self) -> io::Result<()> {
        let mut file = self.take_file().await?;
        let chunks = std::mem::take(&mut self.pending);
        self.pending_len = 0;
        self.in_flight = Some(tokio::task::spawn_blocking(move || {
            write_all_chunks(&mut file, &chunks).map(|()| file)
        }));
        Ok(())
    }

    pub async fn write(&mut self, chunk: Bytes) -> io::Result<()> {
        if self.file.is_none() && self.in_flight.is_none() {
            return Err(closed_stream_writer());
        }
        self.pending_len += chunk.len();
        self.pending.push(chunk);
        if self.pending_len >= DISK_CHUNK_BYTES {
            self.write_pending().await?;
        }
        Ok(())
    }

    pub async fn commit(mut self) -> io::Result<()> {
        if !self.pending.is_empty() {
            self.write_pending().await?;
        }
        drop(self.take_file().await?);
        fs::rename(&self.temp_path, &self.cache_path).await?;
        self.published = true;
        Ok(())
    }
}

impl Drop for StreamCacheWriter {
    fn drop(&mut self) {
        if !self.published {
            self.file.take();
            self.in_flight.take();
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

pub async fn disk_cache_cleanup_task(
    max_bytes: u64,
    max_age_secs: u64,
    cleanup_interval_secs: u64,
) {
    let cache_dirs = ["./cache", "./cache/stream"];
    let base_interval = Duration::from_secs(cleanup_interval_secs.max(60));
    let mut next_interval = Duration::ZERO;
    loop {
        tokio::time::sleep(next_interval).await;
        let mut total_size = 0u64;
        let now = SystemTime::now();
        let mut files = Vec::new();
        for cache_dir in &cache_dirs {
            let Ok(mut entries) = fs::read_dir(cache_dir).await else {
                continue;
            };
            while let Ok(Some(entry)) = entries.next_entry().await {
                let Ok(metadata) = entry.metadata().await else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let expired =
                    now.duration_since(modified).unwrap_or_default().as_secs() > max_age_secs;
                if expired && fs::remove_file(entry.path()).await.is_ok() {
                    continue;
                }
                if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "tmp")
                {
                    continue;
                }
                total_size = total_size.saturating_add(metadata.len());
                files.push(std::cmp::Reverse((modified, entry.path(), metadata.len())));
            }
        }
        if total_size > max_bytes {
            let mut oldest = std::collections::BinaryHeap::from(files);
            let target = max_bytes.saturating_mul(9) / 10;
            while total_size > target {
                let Some(std::cmp::Reverse((_, path, size))) = oldest.pop() else {
                    break;
                };
                if fs::remove_file(path).await.is_ok() {
                    total_size = total_size.saturating_sub(size);
                }
            }
        }
        next_interval = if total_size < max_bytes / 2 {
            base_interval.saturating_mul(2)
        } else {
            base_interval
        };
    }
}

