use crate::cache::{load_stream_from_disk, StreamCacheWriter, StreamDiskEntry};
use crate::state::{AppState, CachedResponse, StreamFill, StreamFillState};
use crate::{negative_message, NEGATIVE};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use bytes::{Bytes, BytesMut};
use futures_util::StreamExt;
use moka::future::Cache;
use reqwest::header::{
    ACCEPT, ACCEPT_RANGES, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE, REFERER, RETRY_AFTER,
};
use serde::Serialize;
use std::io::SeekFrom;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::{mpsc, watch};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;
use url::Url;

mod framex;
mod megaplay;
mod megavid;
mod playlist;
mod prefetch;
mod providers;
mod range;
mod request;
mod segment_cache;
mod segment_fill;
mod subtitles;
mod titles;

use megaplay::*;
use playlist::*;
use prefetch::*;
use providers::*;
use request::*;
use segment_cache::*;
use segment_fill::*;
pub(crate) use segment_fill::LiveSegment;

const MEGAPLAY_BASE: &str = "https://megaplay.buzz";
const MEGAPLAY_REFERER: &str = "https://megaplay.buzz/api";
const SEGMENT_PREFIX_BYTES: usize = 252;
const MAX_METADATA_BYTES: usize = 2 * 1024 * 1024;
const UPSTREAM_REQUEST_BUDGET: Duration = Duration::from_secs(12);
const UPSTREAM_BODY_TIMEOUT: Duration = Duration::from_secs(30);
const SOURCE_RESOLUTION_TIMEOUT: Duration = Duration::from_secs(21);
const QUALITY_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const QUALITY_SETTLE_GRACE: Duration = Duration::from_millis(500);
const AUTO_4K_GRACE: Duration = Duration::from_millis(1500);
const MEDIA_ACCEPT: &str = "video/mp2t,video/mp4,application/octet-stream,*/*";
const DISK_READ_CHUNK_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
enum StreamProvider {
    Megaplay,
    Megavid,
    Framex,
    Framex4k(framex::MovieServer),
    Title,
}

impl StreamProvider {
    const ALL: [Self; 4] = [Self::Framex, Self::Megaplay, Self::Megavid, Self::Title];

    fn id(self) -> &'static str {
        match self {
            Self::Megaplay => "megaplay",
            Self::Megavid => "megavid",
            Self::Framex | Self::Framex4k(_) => "framex",
            Self::Title => "framex-title",
        }
    }

    fn referer(self) -> &'static str {
        match self {
            Self::Megaplay => "https://megaplay.buzz/",
            Self::Megavid => "https://megavid.buzz/",
            Self::Framex => "https://krussdomi.com/",
            Self::Framex4k(server) => server.referer(),
            Self::Title => titles::PAGE_REFERER,
        }
    }

    fn headers(self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(REFERER, HeaderValue::from_static(self.referer()));
        if self == Self::Framex {
            headers.insert("origin", HeaderValue::from_static("https://krussdomi.com"));
        } else if let Self::Framex4k(server) = self {
            headers.insert(
                "origin",
                HeaderValue::from_str(server.referer().trim_end_matches('/')).unwrap(),
            );
        } else if self == Self::Title {
            headers.insert("origin", HeaderValue::from_static(titles::PAGE_ORIGIN));
        }
        headers
    }

    fn supports(self, key: &EpisodeKey) -> bool {
        if self == Self::Title || key.title.is_some() {
            return self == Self::Title && key.title.is_some();
        }
        match self {
            Self::Megaplay => true,
            Self::Megavid => key.anilist_id > 0 || key.mal_id > 0,
            Self::Framex => key.anilist_id > 0,
            Self::Framex4k(_) => key.anilist_id > 0 && key.episode == 1,
            Self::Title => false,
        }
    }

    async fn resolve(
        self,
        client: &reqwest::Client,
        key: &EpisodeKey,
    ) -> Result<ResolvedSource, ResolveError> {
        match self {
            Self::Megaplay => resolve_megaplay(client, key).await,
            Self::Megavid => megavid::resolve(client, key).await,
            Self::Framex => framex::resolve(client, key).await,
            Self::Framex4k(server) => framex::resolve_4k(client, key, server).await,
            Self::Title => titles::resolve(client, key).await,
        }
    }
}

#[derive(Default)]
struct StreamMetrics {
    active_requests: AtomicU64,
    requests: AtomicU64,
    source_cache_hits: AtomicU64,
    source_cache_misses: AtomicU64,
    playlist_cache_hits: AtomicU64,
    playlist_cache_misses: AtomicU64,
    segment_memory_hits: AtomicU64,
    segment_disk_hits: AtomicU64,
    segment_cache_misses: AtomicU64,
    segment_coalesced: AtomicU64,
    segment_live_joins: AtomicU64,
    segment_prefetches: AtomicU64,
    upstream_attempts: AtomicU64,
    upstream_retries: AtomicU64,
    upstream_errors: AtomicU64,
    source_refreshes: AtomicU64,
    range_requests: AtomicU64,
    bytes_served: AtomicU64,
    source_resolution_ms: AtomicU64,
    source_resolutions: AtomicU64,
    playlist_resolution_ms: AtomicU64,
    playlist_resolutions: AtomicU64,
    segment_upstream_ttfb_ms: AtomicU64,
    segment_upstream_ttfb_samples: AtomicU64,
    segment_upstream_download_ms: AtomicU64,
    segment_upstream_downloads: AtomicU64,
    segment_upstream_bytes: AtomicU64,
    downstream_cancellations: AtomicU64,
    segment_partial_fills: AtomicU64,
    segment_failed_fills: AtomicU64,
    segment_disk_write_failures: AtomicU64,
}

static STREAM_METRICS: LazyLock<StreamMetrics> = LazyLock::new(StreamMetrics::default);

struct ActiveRequest;

impl ActiveRequest {
    fn start() -> Self {
        STREAM_METRICS.requests.fetch_add(1, Ordering::Relaxed);
        STREAM_METRICS
            .active_requests
            .fetch_add(1, Ordering::Relaxed);
        Self
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        STREAM_METRICS
            .active_requests
            .fetch_sub(1, Ordering::Relaxed);
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
enum TitleKind {
    Movie,
    Tv,
}

impl TitleKind {
    fn id(self) -> &'static str {
        match self {
            Self::Movie => "movie",
            Self::Tv => "tv",
        }
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct TitleKey {
    kind: TitleKind,
    tmdb_id: u32,
    season: u16,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct EpisodeKey {
    anilist_id: i64,
    mal_id: i64,
    anikoto_episode_id: String,
    title: Option<TitleKey>,
    episode: i32,
    language: String,
    session: String,
    prefer_4k: bool,
    auto_4k: bool,
}

#[derive(Debug, Clone)]
struct SubtitleTrack {
    url: String,
    label: String,
    language: String,
    kind: String,
    default: bool,
    forced: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct TimeMarker {
    start: f64,
    end: f64,
}

#[derive(Debug, Clone, Default)]
struct SourceMetadata {
    duration: Option<f64>,
    intro: Option<TimeMarker>,
    outro: Option<TimeMarker>,
    server: Option<String>,
    languages: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedSource {
    provider: StreamProvider,
    playlist_url: String,
    fallback_playlist_url: Option<String>,
    master: Arc<String>,
    tracks: Vec<SubtitleTrack>,
    internal_id: String,
    generation: u64,
    language: Option<String>,
    metadata: SourceMetadata,
}

impl ResolvedSource {
    fn cache_weight(&self, key: &EpisodeKey) -> u32 {
        let strings = self.playlist_url.len()
            + self.fallback_playlist_url.as_ref().map_or(0, String::len)
            + self.master.len()
            + self.internal_id.len()
            + self.language.as_ref().map_or(0, String::len)
            + self.metadata.server.as_ref().map_or(0, String::len)
            + self.metadata.languages.iter().map(String::len).sum::<usize>()
            + key.anikoto_episode_id.len()
            + key.language.len()
            + key.session.len();
        let tracks: usize = self
            .tracks
            .iter()
            .map(|t| t.url.len() + t.label.len() + t.language.len() + t.kind.len() + 128)
            .sum();
        u32::try_from(strings.saturating_add(tracks).saturating_add(512)).unwrap_or(u32::MAX)
    }
}

#[derive(Debug, Clone, Copy)]
enum ResolveError {
    Invalid,
    Stale,
    NotFound,
    Upstream,
    RateLimited,
    Busy,
    TooLarge,
}

async fn send_with_retry<F>(mut build: F) -> Result<reqwest::Response, ResolveError>
where
    F: FnMut() -> reqwest::RequestBuilder,
{
    const ATTEMPTS: usize = 3;
    let deadline = Instant::now() + UPSTREAM_REQUEST_BUDGET;
    for attempt in 0..ATTEMPTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            STREAM_METRICS
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            return Err(ResolveError::Upstream);
        }
        STREAM_METRICS
            .upstream_attempts
            .fetch_add(1, Ordering::Relaxed);
        let (client, request) = build().build_split();
        let request = request.map_err(|_| ResolveError::Invalid)?;
        crate::safe_dns::validate_public_target(request.url())
            .map_err(|_| ResolveError::Invalid)?;
        let safe_to_retry = crate::proxy::safe_to_retry(request.method());
        match tokio::time::timeout(remaining, client.execute(request)).await {
            Ok(Ok(response)) => {
                let retryable = response.status() == StatusCode::TOO_MANY_REQUESTS
                    || response.status() == StatusCode::BAD_GATEWAY
                    || response.status() == StatusCode::SERVICE_UNAVAILABLE
                    || response.status() == StatusCode::GATEWAY_TIMEOUT;
                if !retryable || !safe_to_retry {
                    return Ok(response);
                }
                if attempt + 1 == ATTEMPTS {
                    STREAM_METRICS
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    return Ok(response);
                }
                STREAM_METRICS
                    .upstream_retries
                    .fetch_add(1, Ordering::Relaxed);
                let retry_after = response
                    .headers()
                    .get(RETRY_AFTER)
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(|seconds| Duration::from_secs(seconds.min(10)))
                    .unwrap_or_else(|| Duration::from_millis(250 * (1 << attempt)));
                let remaining = deadline.saturating_duration_since(Instant::now());
                if retry_after >= remaining {
                    STREAM_METRICS
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    return Ok(response);
                }
                tokio::time::sleep(retry_after).await;
            }
            Ok(Err(_)) | Err(_) if safe_to_retry && attempt + 1 < ATTEMPTS => {
                STREAM_METRICS
                    .upstream_retries
                    .fetch_add(1, Ordering::Relaxed);
                let delay = Duration::from_millis(250 * (1 << attempt));
                let remaining = deadline.saturating_duration_since(Instant::now());
                if delay >= remaining {
                    STREAM_METRICS
                        .upstream_errors
                        .fetch_add(1, Ordering::Relaxed);
                    return Err(ResolveError::Upstream);
                }
                tokio::time::sleep(delay).await;
            }
            Ok(Err(_)) | Err(_) => {
                STREAM_METRICS
                    .upstream_errors
                    .fetch_add(1, Ordering::Relaxed);
                return Err(ResolveError::Upstream);
            }
        }
    }
    STREAM_METRICS
        .upstream_errors
        .fetch_add(1, Ordering::Relaxed);
    Err(ResolveError::Upstream)
}

async fn read_body_limited(
    response: reqwest::Response,
    max_bytes: usize,
) -> Result<Bytes, ResolveError> {
    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        return Err(ResolveError::RateLimited);
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err(ResolveError::TooLarge);
    }
    let capacity = response.content_length().unwrap_or(0).min(max_bytes as u64) as usize;
    let read = async move {
        let mut stream = response.bytes_stream();
        let mut body = BytesMut::with_capacity(capacity);
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| ResolveError::Upstream)?;
            if body.len().saturating_add(chunk.len()) > max_bytes {
                return Err(ResolveError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body.freeze())
    };
    tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, read)
        .await
        .map_err(|_| ResolveError::Upstream)?
}

static SOURCE_CACHE: LazyLock<Cache<(StreamProvider, EpisodeKey), Arc<ResolvedSource>>> =
    LazyLock::new(|| {
        Cache::builder()
            .time_to_live(Duration::from_secs(10 * 60))
            .max_capacity(32 * 1024 * 1024)
            .weigher(
                |(_, key): &(StreamProvider, EpisodeKey), source: &Arc<ResolvedSource>| {
                    source.cache_weight(key)
                },
            )
            .build()
    });

struct SourceSession {
    source: Arc<ResolvedSource>,
    invalidated: AtomicBool,
    refresh: Arc<tokio::sync::Mutex<()>>,
}

impl SourceSession {
    fn new(source: Arc<ResolvedSource>) -> Arc<Self> {
        Arc::new(Self {
            source,
            invalidated: AtomicBool::new(false),
            refresh: Arc::new(tokio::sync::Mutex::new(())),
        })
    }
}

static SESSION_SOURCES: LazyLock<Cache<EpisodeKey, Arc<SourceSession>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_idle(Duration::from_secs(6 * 60 * 60))
        .max_capacity(32 * 1024 * 1024)
        .weigher(|key: &EpisodeKey, session: &Arc<SourceSession>| session.source.cache_weight(key))
        .build()
});

static FAILED_SOURCES: LazyLock<Cache<String, ()>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(5 * 60))
        .max_capacity(10_000)
        .build()
});

static PLAYLIST_CACHE: LazyLock<Cache<String, Arc<String>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(5 * 60))
        .max_capacity(64 * 1024 * 1024)
        .weigher(|key: &String, playlist: &Arc<String>| {
            u32::try_from(key.len().saturating_add(playlist.len()).saturating_add(128))
                .unwrap_or(u32::MAX)
        })
        .build()
});

type PlaylistReferences = (Arc<String>, Arc<Vec<String>>);

static PLAYLIST_REFERENCES: LazyLock<Cache<String, PlaylistReferences>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(5 * 60))
        .max_capacity(64 * 1024 * 1024)
        .weigher(
            |key: &String, (playlist, references): &PlaylistReferences| {
                let urls = references.iter().map(String::len).sum::<usize>();
                u32::try_from(
                    key.len()
                        .saturating_add(playlist.len())
                        .saturating_add(urls)
                        .saturating_add(references.len() * std::mem::size_of::<String>())
                        .saturating_add(128),
                )
                .unwrap_or(u32::MAX)
            },
        )
        .build()
});

static RESOURCE_PROBES: LazyLock<Cache<String, ()>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(60))
        .max_capacity(10_000)
        .build()
});

static QUALITY_DISCOVERY: LazyLock<Cache<EpisodeKey, Option<Arc<ResolvedSource>>>> =
    LazyLock::new(|| {
        Cache::builder()
            .time_to_live(Duration::from_secs(60))
            .max_capacity(8 * 1024 * 1024)
            .weigher(|key: &EpisodeKey, source: &Option<Arc<ResolvedSource>>| {
                source
                    .as_ref()
                    .map_or(256, |source| source.cache_weight(key))
            })
            .build()
    });
static QUALITY_DISCOVERY_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

static KNOWN_4K: LazyLock<Cache<EpisodeKey, Option<StreamProvider>>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(6 * 60 * 60))
        .max_capacity(10_000)
        .build()
});

static WARMED_SOURCES: LazyLock<Cache<u64, ()>> = LazyLock::new(|| {
    Cache::builder()
        .time_to_live(Duration::from_secs(10 * 60))
        .max_capacity(10_000)
        .build()
});

static PROVIDER_FAILURES: LazyLock<Cache<(StreamProvider, EpisodeKey), ResolveError>> =
    LazyLock::new(|| {
        Cache::builder()
            .time_to_live(Duration::from_secs(15))
            .max_capacity(10_000)
            .build()
    });

async fn resource_handler(
    state: &Arc<AppState>,
    key: &EpisodeKey,
    uri: &Uri,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let requested_generation = requested_source_generation(uri)?;
    if let Some(master_resource) = query_value(uri, "master_resource") {
        let master_resource = master_resource
            .parse::<usize>()
            .map_err(|_| ResolveError::Invalid)?;
        let (source, playlist_url, playlist) =
            master_resource_playlist(state, key, master_resource, requested_generation).await?;
        if query_value(uri, "resource").is_none() {
            let query = query_string(
                key,
                &received_anilist_ids(uri),
                &[
                    ("source_generation", source.generation.to_string()),
                    ("master_resource", master_resource.to_string()),
                ],
            );
            let rewritten = rewrite_hls(&playlist, |resource| {
                format!("{}/resource?{query}&resource={resource}", stream_base_path(key))
            })?;
            return Ok(playlist_response(rewritten));
        }
        let resource = query_value(uri, "resource")
            .and_then(|value| value.parse::<usize>().ok())
            .ok_or(ResolveError::Invalid)?;
        let fetched = playlist_resource(
            state,
            &source,
            &playlist_url,
            &playlist,
            resource,
            method,
            request_headers,
        )
        .await
        .and_then(media_response);
        return match fetched {
            Ok(response) => Ok(response),
            Err(ResolveError::NotFound | ResolveError::Upstream) => {
                reject_source(key, &source, &[&source.playlist_url, &playlist_url]).await;
                let (source, playlist_url, playlist) =
                    master_resource_playlist(state, key, master_resource, requested_generation)
                        .await?;
                playlist_resource(
                    state,
                    &source,
                    &playlist_url,
                    &playlist,
                    resource,
                    method,
                    request_headers,
                )
                .await
            }
            Err(error) => Err(error),
        };
    }
    let variant = query_value(uri, "variant")
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or(ResolveError::Invalid)?;
    let resource = query_value(uri, "resource")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(ResolveError::Invalid)?;
    let (source, playlist_url, playlist) =
        media_playlist(state, key, variant, requested_generation).await?;
    let fetched = playlist_resource(
        state,
        &source,
        &playlist_url,
        &playlist,
        resource,
        method,
        request_headers,
    )
    .await
    .and_then(media_response);
    match fetched {
        Ok(response) => Ok(response),
        Err(ResolveError::NotFound | ResolveError::Upstream) => {
            reject_source(key, &source, &[&source.playlist_url, &playlist_url]).await;
            let (source, playlist_url, playlist) =
                media_playlist(state, key, variant, requested_generation).await?;
            playlist_resource(
                state,
                &source,
                &playlist_url,
                &playlist,
                resource,
                method,
                request_headers,
            )
            .await
        }
        Err(error) => Err(error),
    }
}
fn media_response(response: Response) -> Result<Response, ResolveError> {
    match response.status() {
        StatusCode::FORBIDDEN | StatusCode::NOT_FOUND | StatusCode::GONE => {
            Err(ResolveError::NotFound)
        }
        status if status.is_server_error() => Err(ResolveError::Upstream),
        _ => Ok(response),
    }
}

async fn track_handler(
    state: &AppState,
    key: &EpisodeKey,
    uri: &Uri,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let track_index = query_value(uri, "track")
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(ResolveError::Invalid)?;
    let requested_generation = requested_source_generation(uri)?;
    let source = get_source(&state.asset_client, key).await?;
    ensure_source_generation(&source, requested_generation)?;
    let track = source
        .tracks
        .get(track_index)
        .ok_or(ResolveError::Invalid)?;
    let downstream = get_cached_upstream_resource(
        state,
        &track.url,
        source.provider,
        false,
        "text/vtt,text/plain,application/octet-stream",
        &Method::GET,
        &HeaderMap::new(),
    )
    .await?;
    subtitles::response(downstream, method, request_headers).await
}

#[derive(Serialize)]
struct StreamTrack {
    label: String,
    language: String,
    src: String,
    kind: String,
    default: bool,
    forced: bool,
}

pub async fn stream_info_handler(
    state: Arc<AppState>,
    method: Method,
    uri: Uri,
    _headers: HeaderMap,
) -> Response {
    let _active = ActiveRequest::start();
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let result = async {
        let key = parse_episode_key(&uri)?;
        if query_value(&uri, "discover_quality").as_deref() == Some("2160p") {
            let selected = SESSION_SOURCES.get(&key).await.ok_or(ResolveError::Busy)?;
            if selected.invalidated.load(Ordering::Acquire) {
                return Err(ResolveError::Busy);
            }
            let available = has_4k(&selected.source)
                || discover_4k(&state.asset_client, &key, Some(selected.source.provider))
                    .await?
                    .is_some();
            return Ok(Json(serde_json::json!({ "available_4k": available })).into_response());
        }
        let (source, master) = source_master(&state, &key).await?;
        warm_source(&state, &source);
        let anilist_ids = received_anilist_ids(&uri);
        let tracks = source
            .tracks
            .iter()
            .enumerate()
            .map(|(index, track)| StreamTrack {
                label: track.label.clone(),
                language: track.language.clone(),
                src: format!(
                    "{}/track?{}",
                    stream_base_path(&key),
                    query_string(
                        &key,
                        &anilist_ids,
                        &[
                            ("source_generation", source.generation.to_string()),
                            ("track", index.to_string()),
                        ],
                    )
                ),
                kind: track.kind.clone(),
                default: track.default,
                forced: track.forced,
            })
            .collect::<Vec<_>>();
        let qualities = parse_hls_qualities(&master)
            .into_iter()
            .map(|(index, width, height, bitrate, codecs)| {
                serde_json::json!({
                    "index": index,
                    "width": (width > 0).then_some(width),
                    "height": (height > 0).then_some(height),
                    "bitrate": (bitrate > 0).then_some(bitrate),
                    "codecs": (!codecs.is_empty()).then_some(codecs),
                })
            })
            .collect::<Vec<_>>();
        let audio_tracks = parse_hls_audio_tracks(&master)
            .into_iter()
            .map(|(label, language, default)| {
                serde_json::json!({
                    "label": label,
                    "language": language,
                    "default": default,
                })
            })
            .collect::<Vec<_>>();
        Ok::<_, ResolveError>(
            Json(serde_json::json!({
                "hls": is_master_playlist(&master),
                "needs_transmux": false,
                "quality_fallback": key.prefer_4k && !has_4k(&source),
                "tracks": tracks,
                "source": {
                    "provider": source.provider.id(),
                    "id": source.internal_id,
                    "generation": source.generation,
                    "server": source.metadata.server,
                    "language": source.language,
                },
                "media": key.title.map(|title| title.kind.id()).unwrap_or("anime"),
                "languages": source.metadata.languages,
                "duration": source.metadata.duration,
                "intro": source.metadata.intro.map(|marker| {
                    serde_json::json!({"start": marker.start, "end": marker.end})
                }),
                "outro": source.metadata.outro.map(|marker| {
                    serde_json::json!({"start": marker.start, "end": marker.end})
                }),
                "qualities": qualities,
                "audio_tracks": audio_tracks,
            }))
            .into_response(),
        )
    }
    .await;
    if let Err(error) = &result {
        tracing::warn!(
            stage = "stream_info",
            error = ?error,
            "stream stage failed{}",
            NEGATIVE
        );
    }
    result.unwrap_or_else(error_response)
}

pub async fn stream_handler(
    state: Arc<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    let _active = ActiveRequest::start();
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let key = match parse_episode_key(&uri) {
        Ok(key) => key,
        Err(error) => return error_response(error),
    };
    if uri.path().starts_with("/stream/watch/") && key.title.is_none() {
        return error_response(ResolveError::Invalid);
    }
    let result = match uri.path() {
        "/stream/anikoto" | "/stream/watch/playlist" => master_handler(&state, &key, &uri).await,
        "/stream/anikoto/variant" | "/stream/watch/variant" => variant_handler(&state, &key, &uri).await,
        "/stream/anikoto/resource" | "/stream/watch/resource" => resource_handler(&state, &key, &uri, &method, &headers).await,
        "/stream/anikoto/track" | "/stream/watch/track" => track_handler(&state, &key, &uri, &method, &headers).await,
        path if path.starts_with("/stream/s-2/") => master_handler(&state, &key, &uri).await,
        _ => Err(ResolveError::Invalid),
    };
    if let Err(error) = &result {
        tracing::warn!(
            stage = %uri.path(),
            anilist_id = key.anilist_id,
            mal_id = key.mal_id,
            anikoto_episode_id = %key.anikoto_episode_id,
            title = ?key.title,
            episode = key.episode,
            language = %key.language,
            error = ?error,
            "stream stage failed{}",
            NEGATIVE
        );
    }
    result.unwrap_or_else(error_response)
}

pub async fn stream_metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    let resolutions = STREAM_METRICS.source_resolutions.load(Ordering::Relaxed);
    let total_resolution_ms = STREAM_METRICS.source_resolution_ms.load(Ordering::Relaxed);
    let average_resolution_ms = total_resolution_ms.checked_div(resolutions).unwrap_or(0);
    let playlist_resolutions = STREAM_METRICS.playlist_resolutions.load(Ordering::Relaxed);
    let playlist_resolution_ms = STREAM_METRICS
        .playlist_resolution_ms
        .load(Ordering::Relaxed);
    let average_playlist_resolution_ms = playlist_resolution_ms
        .checked_div(playlist_resolutions)
        .unwrap_or(0);
    let segment_ttfb_samples = STREAM_METRICS
        .segment_upstream_ttfb_samples
        .load(Ordering::Relaxed);
    let segment_ttfb_ms = STREAM_METRICS
        .segment_upstream_ttfb_ms
        .load(Ordering::Relaxed);
    let segment_downloads = STREAM_METRICS
        .segment_upstream_downloads
        .load(Ordering::Relaxed);
    let segment_download_ms = STREAM_METRICS
        .segment_upstream_download_ms
        .load(Ordering::Relaxed);
    let segment_ttfb_average_ms = segment_ttfb_ms
        .checked_div(segment_ttfb_samples)
        .unwrap_or(0);
    let segment_download_average_ms = segment_download_ms
        .checked_div(segment_downloads)
        .unwrap_or(0);
    let upstream_capacity = state.stream_upstream_permit.snapshot();
    let rewrite_capacity = state.html_rewrite_permit.snapshot();
    let providers = PROVIDER_HEALTH.lock().unwrap_or_else(|error| error.into_inner())
        .iter().map(|(provider, health)| serde_json::json!({
            "provider": provider.id(),
            "adapter": format!("{provider:?}"),
            "successes": health.successes, "missing": health.missing, "errors": health.errors,
            "skipped": health.skipped, "total_ms": health.elapsed_ms,
            "open": health.open_until.is_some_and(|until| Instant::now() < until),
            "probing": health.probing,
        })).collect::<Vec<_>>();
    let mut response = Json(serde_json::json!({
        "providers": providers,
        "active_requests": STREAM_METRICS.active_requests.load(Ordering::Relaxed),
        "requests": STREAM_METRICS.requests.load(Ordering::Relaxed),
        "source_cache": {
            "hits": STREAM_METRICS.source_cache_hits.load(Ordering::Relaxed),
            "misses": STREAM_METRICS.source_cache_misses.load(Ordering::Relaxed),
        },
        "playlist_cache": {
            "hits": STREAM_METRICS.playlist_cache_hits.load(Ordering::Relaxed),
            "misses": STREAM_METRICS.playlist_cache_misses.load(Ordering::Relaxed),
        },
        "segment_cache": {
            "memory_hits": STREAM_METRICS.segment_memory_hits.load(Ordering::Relaxed),
            "disk_hits": STREAM_METRICS.segment_disk_hits.load(Ordering::Relaxed),
            "misses": STREAM_METRICS.segment_cache_misses.load(Ordering::Relaxed),
            "coalesced": STREAM_METRICS.segment_coalesced.load(Ordering::Relaxed),
            "live_joins": STREAM_METRICS.segment_live_joins.load(Ordering::Relaxed),
            "prefetches": STREAM_METRICS.segment_prefetches.load(Ordering::Relaxed),
            "failed_fills": STREAM_METRICS.segment_failed_fills.load(Ordering::Relaxed),
            "partial_fills": STREAM_METRICS.segment_partial_fills.load(Ordering::Relaxed),
            "disk_write_failures": STREAM_METRICS.segment_disk_write_failures.load(Ordering::Relaxed),
        },
        "upstream": {
            "attempts": STREAM_METRICS.upstream_attempts.load(Ordering::Relaxed),
            "retries": STREAM_METRICS.upstream_retries.load(Ordering::Relaxed),
            "errors": STREAM_METRICS.upstream_errors.load(Ordering::Relaxed),
            "source_refreshes": STREAM_METRICS.source_refreshes.load(Ordering::Relaxed),
        },
        "source_resolution": {
            "count": resolutions,
            "total_ms": total_resolution_ms,
            "average_ms": average_resolution_ms,
        },
        "playlist_resolution": {
            "count": playlist_resolutions,
            "total_ms": playlist_resolution_ms,
            "average_ms": average_playlist_resolution_ms,
        },
        "segment_upstream": {
            "ttfb_samples": segment_ttfb_samples,
            "ttfb_total_ms": segment_ttfb_ms,
            "ttfb_average_ms": segment_ttfb_average_ms,
            "downloads": segment_downloads,
            "download_total_ms": segment_download_ms,
            "download_average_ms": segment_download_average_ms,
            "bytes": STREAM_METRICS.segment_upstream_bytes.load(Ordering::Relaxed),
        },
        "downstream_cancellations": STREAM_METRICS.downstream_cancellations.load(Ordering::Relaxed),
        "range_requests": STREAM_METRICS.range_requests.load(Ordering::Relaxed),
        "bytes_served": STREAM_METRICS.bytes_served.load(Ordering::Relaxed),
        "capacity": {
            "upstream": {
                "active": upstream_capacity.active,
                "limit": upstream_capacity.limit,
                "minimum": upstream_capacity.minimum,
                "maximum": upstream_capacity.maximum,
                "peak": upstream_capacity.peak,
                "waits": upstream_capacity.waits,
                "rejected": upstream_capacity.rejected,
            },
            "rewrite": {
                "active": rewrite_capacity.active,
                "limit": rewrite_capacity.limit,
                "minimum": rewrite_capacity.minimum,
                "maximum": rewrite_capacity.maximum,
                "peak": rewrite_capacity.peak,
                "waits": rewrite_capacity.waits,
                "rejected": rewrite_capacity.rejected,
            }
        }
    }))
    .into_response();
    response.headers_mut().insert(
        "Cache-Control",
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response
}

pub async fn reclaim_caches() {
    SOURCE_CACHE.invalidate_all();
    PROVIDER_FAILURES.invalidate_all();
    QUALITY_DISCOVERY.invalidate_all();
    PLAYLIST_CACHE.invalidate_all();
    PLAYLIST_REFERENCES.invalidate_all();
    FAILED_SOURCES.invalidate_all();
    RESOURCE_PROBES.invalidate_all();
    tokio::join!(
        framex::reclaim_caches(),
        titles::reclaim_caches(),
        SOURCE_CACHE.run_pending_tasks(),
        PROVIDER_FAILURES.run_pending_tasks(),
        QUALITY_DISCOVERY.run_pending_tasks(),
        SESSION_SOURCES.run_pending_tasks(),
        PLAYLIST_CACHE.run_pending_tasks(),
        PLAYLIST_REFERENCES.run_pending_tasks(),
        FAILED_SOURCES.run_pending_tasks(),
        RESOURCE_PROBES.run_pending_tasks()
    );
}




