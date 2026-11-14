pub mod pool;
pub mod protocol;
pub mod worker;

use super::{raw_header, response_with_meta, UpstreamMeta};
use crate::state::AppState;
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::Response;
use base64::Engine as _;
use bytes::Bytes;
use dashmap::DashMap;
use futures_util::future::BoxFuture;
use moka::future::Cache;
use pool::{PoolOutcome, RewritePool};
use protocol::{RewriteConfig, RewriteFlags, UrlModel, WorkerJob, WorkerReply};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const INTENT_HEADER: &str = "x-mochi-folio-rewrite";
pub const REWRITER_HASH: &str = env!("FOLIO_REWRITER_HASH");
const MAX_INTENT_BYTES: usize = 8 * 1024;
const MAX_BASE_BYTES: usize = 2048;
const MAX_URL_MODEL: u32 = 8192;
const BLOCKING_DIGEST_BYTES: usize = 1024 * 1024;
const FAILED_SCRIPT_TTL: Duration = Duration::from_secs(5 * 60);
const BLOCKING_INFLATE_BYTES: usize = 64 * 1024;

const JAVASCRIPT_ESSENCES: &[&str] = &[
    "application/ecmascript",
    "application/javascript",
    "application/x-ecmascript",
    "application/x-javascript",
    "text/ecmascript",
    "text/javascript",
    "text/javascript1.0",
    "text/javascript1.1",
    "text/javascript1.2",
    "text/javascript1.3",
    "text/javascript1.4",
    "text/javascript1.5",
    "text/jscript",
    "text/livescript",
    "text/x-ecmascript",
    "text/x-javascript",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RewriteKind {
    Script,
    Worker,
}

#[derive(Deserialize)]
struct IntentEnvelope {
    v: u32,
    rewriter: String,
    kind: RewriteKind,
    module: bool,
    base: String,
    flags: RewriteFlags,
    config: RewriteConfig,
    #[serde(default)]
    urls: Option<UrlModel>,
}

#[derive(Clone, Debug)]
pub struct RewriteIntent {
    pub kind: RewriteKind,
    pub job: WorkerJob,
    pub accepts_brotli: bool,
}

fn identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    (1..=64).contains(&name.len())
        && bytes
            .next()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_' || byte == b'$')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$')
}

fn replacement_safe(name: &str) -> bool {
    !name
        .as_bytes()
        .windows(2)
        .any(|pair| pair[0] == b'$' && (pair[1] == b'$' || pair[1].is_ascii_digit()))
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    headers
        .get_all("accept-encoding")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|coding| {
            let mut parts = coding.split(';').map(str::trim);
            parts
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("br"))
                && !parts.any(|parameter| {
                    parameter
                        .strip_prefix("q=")
                        .and_then(|weight| weight.parse::<f32>().ok())
                        .is_some_and(|weight| weight <= 0.0)
                })
        })
}

pub fn parse_intent(headers: &HeaderMap) -> Result<Option<RewriteIntent>, &'static str> {
    let Some(encoded) = headers.get(INTENT_HEADER) else {
        return Ok(None);
    };
    if encoded.len() > MAX_INTENT_BYTES * 2 {
        return Err("intent");
    }
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .map_err(|_| "intent")?;
    if decoded.len() > MAX_INTENT_BYTES {
        return Err("intent");
    }
    let intent: IntentEnvelope = serde_json::from_slice(&decoded).map_err(|_| "intent")?;
    if intent.v != 1 {
        return Err("intent");
    }
    if intent.rewriter != REWRITER_HASH {
        return Err("rewriter-version");
    }
    let base_is_http = intent.base.len() <= MAX_BASE_BYTES
        && url::Url::parse(&intent.base)
            .is_ok_and(|base| matches!(base.scheme(), "http" | "https"));
    if !base_is_http
        || !intent.config.values().into_iter().all(identifier)
        || !replacement_safe(&intent.config.pushsourcemapfn)
        || intent
            .urls
            .is_some_and(|model| model.fixed > MAX_URL_MODEL || model.sealed > MAX_URL_MODEL)
    {
        return Err("intent");
    }
    Ok(Some(RewriteIntent {
        kind: intent.kind,
        accepts_brotli: accepts_brotli(headers),
        job: WorkerJob {
            module: intent.module,
            base: intent.base,
            flags: intent.flags,
            config: intent.config,
            urls: intent.urls,
        },
    }))
}

fn mime_essence(content_type: &str) -> String {
    content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim_matches(['\t', '\n', '\u{c}', '\r', ' '])
        .to_ascii_lowercase()
}

pub fn eligibility(
    intent: &RewriteIntent,
    status: u16,
    raw_headers: &[(String, String)],
    body_len: usize,
    max_bytes: usize,
) -> Result<(), &'static str> {
    if status == 206 || raw_header(raw_headers, "content-range").is_some() {
        return Err("range");
    }
    if !(200..300).contains(&status) {
        return Err("status");
    }
    if body_len == 0 {
        return Err("empty");
    }
    if body_len > max_bytes {
        return Err("too-large");
    }
    if raw_header(raw_headers, "content-encoding")
        .is_some_and(|coding| !coding.trim().eq_ignore_ascii_case("identity"))
    {
        return Err("encoding");
    }
    if intent.kind == RewriteKind::Script && intent.job.module {
        if let Some(content_type) = raw_header(raw_headers, "content-type") {
            if !JAVASCRIPT_ESSENCES.contains(&mime_essence(content_type).as_str()) {
                return Err("mime");
            }
        }
    }
    Ok(())
}

pub fn cache_key(job: &WorkerJob, digest: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    let mut field = |bytes: &[u8]| {
        hasher.update((bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    };
    field(b"folio-rewrite-v1");
    field(REWRITER_HASH.as_bytes());
    field(&[job.module as u8]);
    field(job.base.as_bytes());
    field(&job.flags.values().map(u8::from));
    for value in job.config.values() {
        field(value.as_bytes());
    }
    match job.urls {
        Some(model) => field(&[model.fixed.to_be_bytes(), model.sealed.to_be_bytes()].concat()),
        None => field(&[]),
    }
    field(digest);
    hex::encode(hasher.finalize())
}

pub async fn body_digest(body: &Bytes) -> [u8; 32] {
    if body.len() <= BLOCKING_DIGEST_BYTES {
        return Sha256::digest(body).into();
    }
    let owned = body.clone();
    match tokio::task::spawn_blocking(move || Sha256::digest(&owned).into()).await {
        Ok(digest) => digest,
        Err(_) => Sha256::digest(body).into(),
    }
}

pub fn rewritten_headers(raw: &[(String, String)]) -> Vec<(String, String)> {
    raw.iter()
        .filter(|(name, _)| {
            ![
                "content-encoding",
                "content-length",
                "content-range",
                "transfer-encoding",
            ]
            .iter()
            .any(|dropped| name.eq_ignore_ascii_case(dropped))
        })
        .cloned()
        .collect()
}

#[derive(Clone)]
enum RewriteEntry {
    Rewritten {
        patched: bool,
        length: u64,
        payload: Bytes,
    },
    Declined(&'static str),
}

pub struct RewrittenScript {
    pub patched: bool,
    pub length: u64,
    pub payload: Bytes,
}

pub trait RewriteBackend: Send + Sync {
    fn run<'job>(
        &'job self,
        job: &'job WorkerJob,
        body: &'job [u8],
    ) -> BoxFuture<'job, PoolOutcome>;
    fn workers_spawned(&self) -> u64;
}

impl RewriteBackend for RewritePool {
    fn run<'job>(
        &'job self,
        job: &'job WorkerJob,
        body: &'job [u8],
    ) -> BoxFuture<'job, PoolOutcome> {
        Box::pin(RewritePool::run(self, job, body))
    }

    fn workers_spawned(&self) -> u64 {
        self.spawned()
    }
}

#[derive(Default)]
struct RewriteMetrics {
    requests: AtomicU64,
    cache_hits: AtomicU64,
    rewrites: AtomicU64,
    rewrite_ms: AtomicU64,
    worker_failures: AtomicU64,
    declined: DashMap<&'static str, u64>,
}

pub struct FolioRewriter {
    backend: Arc<dyn RewriteBackend>,
    cache: Cache<String, RewriteEntry>,
    failed: Cache<String, ()>,
    max_bytes: usize,
    metrics: RewriteMetrics,
}

fn declined_reason(reason: &str) -> Option<&'static str> {
    ["not-utf8", "parse", "url", "output"]
        .into_iter()
        .find(|known| *known == reason)
}

impl FolioRewriter {
    pub fn new(backend: Arc<dyn RewriteBackend>, cache_bytes: u64, max_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            backend,
            cache: Cache::builder()
                .max_capacity(cache_bytes)
                .weigher(|key: &String, entry: &RewriteEntry| -> u32 {
                    let payload = match entry {
                        RewriteEntry::Rewritten { payload, .. } => payload.len(),
                        RewriteEntry::Declined(_) => 0,
                    };
                    payload
                        .saturating_add(key.len())
                        .saturating_add(128)
                        .try_into()
                        .unwrap_or(u32::MAX)
                })
                .build(),
            failed: Cache::builder()
                .max_capacity(16 * 1024)
                .time_to_live(FAILED_SCRIPT_TTL)
                .build(),
            max_bytes,
            metrics: RewriteMetrics::default(),
        })
    }

    pub fn max_bytes(&self) -> usize {
        self.max_bytes
    }

    pub fn decline<T>(&self, reason: &'static str) -> Result<T, &'static str> {
        *self.metrics.declined.entry(reason).or_insert(0) += 1;
        Err(reason)
    }

    pub fn metrics(&self) -> serde_json::Value {
        let metrics = &self.metrics;
        let mut declined = metrics
            .declined
            .iter()
            .map(|entry| (*entry.key(), *entry.value()))
            .collect::<Vec<_>>();
        declined.sort_unstable();
        serde_json::json!({
            "requests": metrics.requests.load(Ordering::Relaxed),
            "cache_hits": metrics.cache_hits.load(Ordering::Relaxed),
            "rewrites": metrics.rewrites.load(Ordering::Relaxed),
            "rewrite_ms": metrics.rewrite_ms.load(Ordering::Relaxed),
            "worker_failures": metrics.worker_failures.load(Ordering::Relaxed),
            "declines": declined.iter().map(|(_, count)| count).sum::<u64>(),
            "declined": declined
                .into_iter()
                .map(|(reason, count)| (reason.to_owned(), count.into()))
                .collect::<serde_json::Map<_, _>>(),
            "cache_entries": self.cache.entry_count(),
            "cache_bytes": self.cache.weighted_size(),
            "workers_spawned": self.backend.workers_spawned(),
        })
    }

    async fn run_job(
        &self,
        key: &str,
        job: WorkerJob,
        body: Bytes,
        ran: &AtomicBool,
    ) -> Result<RewriteEntry, &'static str> {
        ran.store(true, Ordering::Relaxed);
        let started = Instant::now();
        match self.backend.run(&job, &body).await {
            PoolOutcome::Done {
                reply: WorkerReply::Rewritten { patched, length },
                payload,
            } => {
                self.metrics.rewrites.fetch_add(1, Ordering::Relaxed);
                self.metrics.rewrite_ms.fetch_add(
                    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
                    Ordering::Relaxed,
                );
                Ok(RewriteEntry::Rewritten {
                    patched,
                    length,
                    payload,
                })
            }
            PoolOutcome::Done {
                reply: WorkerReply::Declined { reason },
                ..
            } => declined_reason(&reason)
                .map(RewriteEntry::Declined)
                .ok_or("protocol"),
            PoolOutcome::Unavailable(reason) => {
                if matches!(reason, "timeout" | "crashed") {
                    self.failed.insert(key.to_owned(), ()).await;
                }
                if !matches!(reason, "busy" | "cooldown") {
                    self.metrics.worker_failures.fetch_add(1, Ordering::Relaxed);
                }
                Err(reason)
            }
        }
    }

    pub async fn rewrite(
        self: &Arc<Self>,
        job: &WorkerJob,
        digest: &[u8; 32],
        body: Bytes,
    ) -> Result<RewrittenScript, &'static str> {
        self.metrics.requests.fetch_add(1, Ordering::Relaxed);
        let key = cache_key(job, digest);
        let entry = match self.cache.get(&key).await {
            Some(entry) => {
                self.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
                entry
            }
            None => {
                if self.failed.contains_key(&key) {
                    return self.decline("recent-failure");
                }
                let rewriter = self.clone();
                let job = job.clone();
                let task = tokio::spawn(async move {
                    let ran = AtomicBool::new(false);
                    let entry = rewriter
                        .cache
                        .try_get_with_by_ref(&key, rewriter.run_job(&key, job, body, &ran))
                        .await;
                    (entry, ran.into_inner())
                });
                match task.await {
                    Ok((Ok(entry), ran)) => {
                        if !ran {
                            self.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
                        }
                        entry
                    }
                    Ok((Err(reason), _)) => return self.decline(*reason),
                    Err(_) => return self.decline("worker"),
                }
            }
        };
        match entry {
            RewriteEntry::Rewritten {
                patched,
                length,
                payload,
            } => Ok(RewrittenScript {
                patched,
                length,
                payload,
            }),
            RewriteEntry::Declined(reason) => self.decline(reason),
        }
    }
}

fn inflate(payload: &[u8], limit: usize) -> Option<Bytes> {
    use std::io::Read;
    let mut output = Vec::with_capacity(payload.len().saturating_mul(4));
    brotli::Decompressor::new(payload, 64 * 1024)
        .take(limit as u64 + 1)
        .read_to_end(&mut output)
        .ok()
        .filter(|read| *read <= limit)
        .map(|_| output.into())
}

async fn inflated(payload: Bytes, limit: usize) -> Option<Bytes> {
    if payload.len() <= BLOCKING_INFLATE_BYTES {
        return inflate(&payload, limit);
    }
    tokio::task::spawn_blocking(move || inflate(&payload, limit))
        .await
        .ok()
        .flatten()
}

pub(super) async fn respond(
    state: &Arc<AppState>,
    intent: &RewriteIntent,
    mut meta: UpstreamMeta,
    body: Bytes,
    known_digest: &std::sync::OnceLock<[u8; 32]>,
) -> Response {
    let Some(rewriter) = state.folio_rewriter.as_ref() else {
        return response_with_meta(Body::from(body), &meta);
    };
    let eligible = eligibility(
        intent,
        meta.status,
        &meta.raw_headers,
        body.len(),
        rewriter.max_bytes(),
    )
    .or_else(|reason| rewriter.decline(reason))
    .and_then(|()| {
        if state.memory_pressure.shedding() {
            rewriter.decline("shedding")
        } else {
            Ok(())
        }
    });
    if eligible.is_err() {
        return response_with_meta(Body::from(body), &meta);
    }
    let digest = match known_digest.get() {
        Some(digest) => *digest,
        None => {
            let digest = body_digest(&body).await;
            let _ = known_digest.set(digest);
            digest
        }
    };
    let Ok(script) = rewriter.rewrite(&intent.job, &digest, body.clone()).await else {
        return response_with_meta(Body::from(body), &meta);
    };
    let length = usize::try_from(script.length).unwrap_or(usize::MAX);
    let payload = if intent.accepts_brotli {
        Some(script.payload)
    } else {
        inflated(script.payload, length).await
    };
    let Some(payload) = payload else {
        let _ = rewriter.decline::<()>("output");
        return response_with_meta(Body::from(body), &meta);
    };
    meta.raw_headers = rewritten_headers(&meta.raw_headers);
    meta.raw_headers
        .push(("content-length".into(), script.length.to_string()));
    meta.rewritten = Some(if script.patched { 2 } else { 1 });
    let mut response = response_with_meta(Body::from(payload), &meta);
    if intent.accepts_brotli && response.headers().contains_key(super::UPSTREAM_META_HEADER) {
        response
            .headers_mut()
            .insert("content-encoding", HeaderValue::from_static("br"));
    }
    response
}


