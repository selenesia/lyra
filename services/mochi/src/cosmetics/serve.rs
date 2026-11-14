use super::catalog::{self, Index};
use super::sync::{self, FetchError};
use super::Config;
use crate::negative_message;
use axum::body::Body;
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, ETAG, IF_NONE_MATCH, RANGE,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant, SystemTime};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

const RECHECK: Duration = Duration::from_secs(10);
const CATALOG_CACHE: &str = "public, max-age=300, stale-while-revalidate=86400";
const ASSET_CACHE: &str = "public, max-age=31536000, immutable";

pub struct Loaded {
    stamp: (SystemTime, u64),
    catalog: Bytes,
    etag: HeaderValue,
    assets: HashMap<String, String>,
}

pub struct Cosmetics {
    pub config: Config,
    pub client: reqwest::Client,
    loaded: RwLock<Option<Arc<Loaded>>>,
    checked: RwLock<Option<Instant>>,
    reload: tokio::sync::Mutex<()>,
    fills: moka::future::Cache<String, u64>,
    downloads: tokio::sync::Semaphore,
}

impl Cosmetics {
    pub fn new(config: Config, client: reqwest::Client) -> Arc<Self> {
        Arc::new(Self {
            config,
            client,
            loaded: RwLock::new(None),
            checked: RwLock::new(None),
            reload: tokio::sync::Mutex::new(()),
            downloads: tokio::sync::Semaphore::new(sync::DOWNLOAD_CONCURRENCY),
            fills: moka::future::Cache::builder()
                .max_capacity(20_000)
                .time_to_idle(Duration::from_secs(10 * 60))
                .build(),
        })
    }

    fn snapshot(&self) -> Option<Arc<Loaded>> {
        self.loaded.read().ok()?.clone()
    }

    async fn current(&self) -> Option<Arc<Loaded>> {
        let fresh = self
            .checked
            .read()
            .ok()
            .and_then(|checked| *checked)
            .is_some_and(|checked| checked.elapsed() < RECHECK);
        if fresh {
            return self.snapshot();
        }
        let _guard = self.reload.lock().await;
        let fresh = self
            .checked
            .read()
            .ok()
            .and_then(|checked| *checked)
            .is_some_and(|checked| checked.elapsed() < RECHECK);
        if fresh {
            return self.snapshot();
        }
        let path = self.config.dir.join(sync::INDEX_FILE);
        let stamp = tokio::fs::metadata(&path)
            .await
            .ok()
            .and_then(|meta| Some((meta.modified().ok()?, meta.len())));
        let previous = self.snapshot();
        let next = match stamp {
            None => None,
            Some(stamp) if previous.as_ref().is_some_and(|loaded| loaded.stamp == stamp) => previous,
            Some(stamp) => tokio::task::spawn_blocking(move || load(&path, stamp))
                .await
                .ok()
                .flatten()
                .map(Arc::new)
                .or(previous),
        };
        if let Ok(mut loaded) = self.loaded.write() {
            loaded.clone_from(&next);
        }
        if let Ok(mut checked) = self.checked.write() {
            *checked = Some(Instant::now());
        }
        next
    }

    async fn fill(&self, name: &str, url: &str) -> Result<u64, Arc<FetchError>> {
        let dir = self.config.dir.clone();
        let client = self.client.clone();
        let (owned_name, owned_url) = (name.to_owned(), url.to_owned());
        self.fills
            .try_get_with(owned_name.clone(), async move {
                let _permit = self.downloads.acquire().await.map_err(|_| FetchError::Network)?;
                sync::fetch_asset(&client, &dir, &owned_name, &owned_url).await
            })
            .await
    }
}

fn load(path: &std::path::Path, stamp: (SystemTime, u64)) -> Option<Loaded> {
    let bytes = std::fs::read(path).ok()?;
    let index: Index = serde_json::from_slice(&bytes).ok()?;
    let etag = HeaderValue::from_str(&format!("\"{}\"", index.catalog.version)).ok()?;
    let catalog = Bytes::from(serde_json::to_vec(&index.catalog).ok()?);
    Some(Loaded {
        stamp,
        catalog,
        etag,
        assets: index.assets.into_iter().collect(),
    })
}

fn etag_matches(headers: &HeaderMap, etag: &str) -> bool {
    headers
        .get_all(IF_NONE_MATCH)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|candidate| candidate.trim().trim_start_matches("W/"))
        .any(|candidate| candidate == "*" || candidate == etag)
}

fn unavailable(status: StatusCode, message: &str) -> Response {
    (
        status,
        [(CACHE_CONTROL, HeaderValue::from_static("no-store"))],
        negative_message(message),
    )
        .into_response()
}

pub async fn catalog_handler(cosmetics: Arc<Cosmetics>, method: Method, headers: HeaderMap) -> Response {
    let Some(loaded) = cosmetics.current().await else {
        return unavailable(StatusCode::SERVICE_UNAVAILABLE, "cosmetics are unavailable right now");
    };
    let etag = loaded.etag.to_str().unwrap_or_default();
    let mut response = if etag_matches(&headers, etag) {
        StatusCode::NOT_MODIFIED.into_response()
    } else if method == Method::HEAD {
        (StatusCode::OK, [(CONTENT_LENGTH, loaded.catalog.len().to_string())]).into_response()
    } else {
        (StatusCode::OK, loaded.catalog.clone()).into_response()
    };
    let response_headers = response.headers_mut();
    response_headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static(CATALOG_CACHE));
    response_headers.insert(ETAG, loaded.etag.clone());
    response
}

pub fn parse_range(headers: &HeaderMap, length: u64) -> Option<Result<(u64, u64), ()>> {
    let value = headers.get(RANGE)?.to_str().ok()?.trim();
    let spec = value.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (start, end) = spec.split_once('-')?;
    let (start, end) = (start.trim(), end.trim());
    let range = if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 {
            return Some(Err(()));
        }
        (length.saturating_sub(suffix), length.checked_sub(1)?)
    } else {
        let start: u64 = start.parse().ok()?;
        let end: u64 = if end.is_empty() { length.saturating_sub(1) } else { end.parse().ok()? };
        (start, end.min(length.saturating_sub(1)))
    };
    Some(if length == 0 || range.0 > range.1 || range.0 >= length { Err(()) } else { Ok(range) })
}

async fn serve_file(path: &std::path::Path, key: &str, extension: &str, method: &Method, headers: &HeaderMap) -> Option<Response> {
    let mut file = tokio::fs::File::open(path).await.ok()?;
    let length = file.metadata().await.ok()?.len();
    let etag = format!("\"{key}\"");
    let content_type = if extension == "webm" { "video/webm" } else { "image/png" };
    let base = [
        (CONTENT_TYPE, HeaderValue::from_static(content_type)),
        (CACHE_CONTROL, HeaderValue::from_static(ASSET_CACHE)),
        (ACCEPT_RANGES, HeaderValue::from_static("bytes")),
        (X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff")),
        (ETAG, HeaderValue::from_str(&etag).ok()?),
    ];
    if etag_matches(headers, &etag) {
        return Some((StatusCode::NOT_MODIFIED, base).into_response());
    }
    let (status, start, end) = match parse_range(headers, length) {
        Some(Ok((start, end))) => (StatusCode::PARTIAL_CONTENT, start, end),
        Some(Err(())) => {
            return Some(
                (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    base,
                    [(CONTENT_RANGE, format!("bytes */{length}"))],
                )
                    .into_response(),
            )
        }
        None => (StatusCode::OK, 0, length.saturating_sub(1)),
    };
    let size = if length == 0 { 0 } else { end - start + 1 };
    let mut response = if *method == Method::HEAD {
        (status, base).into_response()
    } else {
        if start > 0 {
            file.seek(std::io::SeekFrom::Start(start)).await.ok()?;
        }
        let stream = ReaderStream::with_capacity(file.take(size), 64 * 1024);
        (status, base, Body::from_stream(stream)).into_response()
    };
    let response_headers = response.headers_mut();
    response_headers.insert(CONTENT_LENGTH, HeaderValue::from(size));
    if status == StatusCode::PARTIAL_CONTENT {
        response_headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{length}")).ok()?,
        );
    }
    Some(response)
}

pub async fn asset_handler(cosmetics: Arc<Cosmetics>, name: String, method: Method, headers: HeaderMap) -> Response {
    let Some((key, extension)) = catalog::split_asset_name(&name) else {
        return unavailable(StatusCode::NOT_FOUND, "that cosmetic does not exist");
    };
    let path = sync::asset_path(&cosmetics.config.dir, &name);
    if let Some(response) = serve_file(&path, key, extension, &method, &headers).await {
        return response;
    }
    let url = cosmetics
        .current()
        .await
        .and_then(|loaded| loaded.assets.get(key).cloned());
    let Some(url) = url else {
        return unavailable(StatusCode::NOT_FOUND, "that cosmetic does not exist");
    };
    if let Err(error) = cosmetics.fill(&name, &url).await {
        tracing::debug!(asset = %name, ?error, "cosmetic asset fill failed{}", crate::NEGATIVE);
        return unavailable(StatusCode::BAD_GATEWAY, "that cosmetic is unavailable right now");
    }
    match serve_file(&path, key, extension, &method, &headers).await {
        Some(response) => response,
        None => unavailable(StatusCode::BAD_GATEWAY, "that cosmetic is unavailable right now"),
    }
}
