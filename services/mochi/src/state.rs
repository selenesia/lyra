use adaptive_capacity::AdaptiveGate;
use aho_corasick::AhoCorasick;
use axum::http::HeaderMap;
use bytes::Bytes;
use dashmap::DashMap;
use moka::future::Cache;
use reqwest::Client;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

#[derive(Clone)]
pub struct CachedResponse {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Bytes,
}

#[derive(Clone)]
pub struct FolioCachedResponse {
    pub status: u16,
    pub status_text: String,
    pub url: String,
    pub request_url: String,
    pub raw_headers: Vec<(String, String)>,
    pub body: Bytes,
    pub fresh_until_ms: u64,
    pub stored_at_ms: u64,
    pub body_digest: std::sync::OnceLock<[u8; 32]>,
}

impl FolioCachedResponse {
    pub fn cache_weight(&self, key: &str) -> u32 {
        let headers = self.raw_headers.iter().fold(0usize, |size, (name, value)| {
            size.saturating_add(name.capacity())
                .saturating_add(value.capacity())
        });
        self.body
            .len()
            .saturating_add(key.len())
            .saturating_add(self.url.capacity())
            .saturating_add(self.request_url.capacity())
            .saturating_add(self.status_text.capacity())
            .saturating_add(self.raw_headers.capacity() * std::mem::size_of::<(String, String)>())
            .saturating_add(headers)
            .saturating_add(512)
            .try_into()
            .unwrap_or(u32::MAX)
    }
}

#[derive(Default)]
pub struct FolioMetrics {
    pub active_requests: AtomicU64,
    pub requests: AtomicU64,
    pub cache_hits: AtomicU64,
    pub cache_misses: AtomicU64,
    pub cache_revalidations: AtomicU64,
    pub rejected_targets: AtomicU64,
    pub upstream_errors: AtomicU64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum StreamFillState {
    Complete,
    Failed,
    Interrupted,
}

#[derive(Default)]
pub struct StreamFill {
    pub state: Arc<Mutex<Option<StreamFillState>>>,
    pub live: std::sync::Mutex<Option<Arc<crate::stream::LiveSegment>>>,
    pub ready: tokio::sync::Notify,
}

pub struct AppState {
    pub websocket_permit: Arc<tokio::sync::Semaphore>,
    pub memory_pressure: Arc<crate::memory::MemoryPressure>,
    pub html_client: Client,
    pub asset_client: Client,
    pub raw_client: Client,
    pub folio_client: wreq::Client,
    pub cache: Cache<String, Arc<CachedResponse>>,
    pub stream_cache: Cache<String, Arc<CachedResponse>>,
    pub stream_fills: Cache<String, Arc<StreamFill>>,
    pub folio_cache: Cache<String, Arc<FolioCachedResponse>>,
    pub effective_bases: Cache<String, url::Url>,
    pub folio_cache_generation: AtomicU64,
    pub folio_metrics: FolioMetrics,
    pub folio_rewriter: Option<Arc<crate::folio::rewrite::FolioRewriter>>,
    pub blocklist_matcher: Arc<AhoCorasick>,
    pub caching_inflight: DashMap<String, ()>,
    pub coalesce: DashMap<String, broadcast::Sender<Arc<CachedResponse>>>,
    pub request_permit: Arc<AdaptiveGate>,
    pub stream_upstream_permit: Arc<AdaptiveGate>,
    pub html_rewrite_permit: Arc<AdaptiveGate>,
    pub max_cache_entry_size: usize,
    pub disk_cache_max_age_secs: u64,
    pub folio_cache_max_entry_size: usize,
    pub folio_cache_max_ttl_secs: u64,
    pub stream_max_entry_size: usize,
    pub ram_cache_limit: usize,
    pub channel_buffer: usize,
    pub stream_prefetch_segments: usize,
}
