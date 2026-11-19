pub mod pool;
pub mod protocol;
pub mod worker;

use super::coding::{self, Accepted, Coding};
use super::{coded_response, raw_header, response_with_meta, with_coding, UpstreamMeta};
use crate::state::AppState;
use axum::body::Body;
use axum::http::HeaderMap;
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
const MAX_OUTPUT_GROWTH: u64 = 8;
const BROTLI_QUALITY: u32 = 5;
const BROTLI_WINDOW: u32 = 22;

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
        job: WorkerJob {
            module: intent.module,
            base: intent.base,
            flags: intent.flags,
            config: intent.config,
            urls: intent.urls,
            coding: None,
            max_source_bytes: 0,
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
    field(b"folio-rewrite-v2");
    field(REWRITER_HASH.as_bytes());
    field(job.coding.map_or("identity", Coding::name).as_bytes());
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

pub struct RewrittenPayload {
    zstd: Bytes,
    brotli: tokio::sync::OnceCell<Option<Bytes>>,
}

impl RewrittenPayload {
    fn new(zstd: Bytes) -> Arc<Self> {
        Arc::new(Self {
            zstd,
            brotli: tokio::sync::OnceCell::new(),
        })
    }

    pub fn zstd(&self) -> &Bytes {
        &self.zstd
    }

    fn weight(&self) -> usize {
        let brotli = self
            .brotli
            .get()
            .and_then(Option::as_ref)
            .map_or(0, Bytes::len);
        self.zstd.len().saturating_add(brotli)
    }
}

#[derive(Clone)]
enum RewriteEntry {
    Rewritten {
        patched: bool,
        length: u64,
        payload: Arc<RewrittenPayload>,
    },
    Declined(&'static str),
}

pub struct RewrittenScript {
    pub patched: bool,
    pub length: u64,
    pub payload: Arc<RewrittenPayload>,
    key: String,
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
    transcodes: AtomicU64,
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
    [
        "not-utf8",
        "parse",
        "url",
        "output",
        "encoding",
        "too-large",
    ]
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
                        RewriteEntry::Rewritten { payload, .. } => payload.weight(),
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
            "transcodes": metrics.transcodes.load(Ordering::Relaxed),
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
                reply: WorkerReply::Rewritten { length, .. },
                ..
            } if length > (self.max_bytes as u64).saturating_mul(MAX_OUTPUT_GROWTH) => {
                Ok(RewriteEntry::Declined("too-large"))
            }
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
                    payload: RewrittenPayload::new(payload),
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
        coding: Option<Coding>,
        digest: &[u8; 32],
        body: Bytes,
    ) -> Result<RewrittenScript, &'static str> {
        self.metrics.requests.fetch_add(1, Ordering::Relaxed);
        let job = &WorkerJob {
            coding,
            max_source_bytes: self.max_bytes as u64,
            ..job.clone()
        };
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
                let key = key.clone();
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
                key,
            }),
            RewriteEntry::Declined(reason) => self.decline(reason),
        }
    }

    pub async fn brotli(&self, script: &RewrittenScript) -> Option<Bytes> {
        let made = AtomicBool::new(false);
        let brotli = script
            .payload
            .brotli
            .get_or_init(|| async {
                made.store(true, Ordering::Relaxed);
                let zstd = script.payload.zstd.clone();
                let length = script.length;
                tokio::task::spawn_blocking(move || transcode_to_brotli(&zstd, length))
                    .await
                    .ok()
                    .flatten()
            })
            .await
            .clone();
        if made.into_inner() && brotli.is_some() {
            self.metrics.transcodes.fetch_add(1, Ordering::Relaxed);
            self.cache
                .insert(
                    script.key.clone(),
                    RewriteEntry::Rewritten {
                        patched: script.patched,
                        length: script.length,
                        payload: script.payload.clone(),
                    },
                )
                .await;
        }
        brotli
    }
}

fn transcode_to_brotli(zstd: &[u8], length: u64) -> Option<Bytes> {
    use std::io::Write;
    let script = coding::decode(Coding::Zstd, zstd, usize::try_from(length).ok()?).ok()?;
    let mut encoder = brotli::CompressorWriter::new(
        Vec::with_capacity(zstd.len()),
        64 * 1024,
        BROTLI_QUALITY,
        BROTLI_WINDOW,
    );
    encoder.write_all(&script).ok()?;
    Some(encoder.into_inner().into())
}

async fn inflated(payload: Bytes, limit: usize) -> Option<Bytes> {
    let inflate = move || {
        coding::decode(Coding::Zstd, &payload, limit)
            .ok()
            .map(Bytes::from)
    };
    if limit <= BLOCKING_INFLATE_BYTES {
        return inflate();
    }
    tokio::task::spawn_blocking(inflate).await.ok().flatten()
}

pub(super) async fn respond(
    state: &Arc<AppState>,
    intent: &RewriteIntent,
    accepted: Accepted,
    mut meta: UpstreamMeta,
    (body, coding): (Bytes, Option<Coding>),
    known_digest: &std::sync::OnceLock<[u8; 32]>,
) -> Response {
    let original = |body: Bytes, meta: &UpstreamMeta| {
        coded_response(state, Body::from(body), coding, accepted, meta)
    };
    let Some(rewriter) = state.folio_rewriter.as_ref() else {
        return original(body, &meta);
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
        return original(body, &meta);
    }
    let digest = match known_digest.get() {
        Some(digest) => *digest,
        None => {
            let digest = body_digest(&body).await;
            let _ = known_digest.set(digest);
            digest
        }
    };
    let Ok(script) = rewriter
        .rewrite(&intent.job, coding, &digest, body.clone())
        .await
    else {
        return original(body, &meta);
    };
    let length = usize::try_from(script.length).unwrap_or(usize::MAX);
    let (served, payload) = if accepted.allows(Coding::Zstd) {
        (Some(Coding::Zstd), Some(script.payload.zstd().clone()))
    } else if accepted.allows(Coding::Br) {
        (Some(Coding::Br), rewriter.brotli(&script).await)
    } else {
        (None, inflated(script.payload.zstd().clone(), length).await)
    };
    let Some(payload) = payload else {
        let _ = rewriter.decline::<()>("output");
        return original(body, &meta);
    };
    meta.raw_headers = rewritten_headers(&meta.raw_headers);
    meta.raw_headers
        .push(("content-length".into(), script.length.to_string()));
    meta.rewritten = Some(if script.patched { 2 } else { 1 });
    with_coding(response_with_meta(Body::from(payload), &meta), served)
}


