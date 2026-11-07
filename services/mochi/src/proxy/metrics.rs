use super::*;

#[derive(Default)]
pub(super) struct ProxyMetrics {
    pub(super) requests: AtomicU64,
    pub(super) raw_requests: AtomicU64,
    pub(super) cache_hits: AtomicU64,
    pub(super) disk_cache_hits: AtomicU64,
    pub(super) coalesced_requests: AtomicU64,
    pub(super) upstream_requests: AtomicU64,
    pub(super) upstream_retries: AtomicU64,
    pub(super) upstream_errors: AtomicU64,
    pub(super) network_errors: AtomicU64,
    pub(super) temporary_source_errors: AtomicU64,
    pub(super) unavailable_source_errors: AtomicU64,
    pub(super) implementation_errors: AtomicU64,
    pub(super) html_rewrites: AtomicU64,
    pub(super) policy_denials: AtomicU64,
    pub(super) cache_candidates: AtomicU64,
    pub(super) cache_bypasses: AtomicU64,
    pub(super) upstream_statuses: [AtomicU64; 6],
}

pub(super) static PROXY_METRICS: OnceLock<ProxyMetrics> = OnceLock::new();

pub(super) fn proxy_metrics() -> &'static ProxyMetrics {
    PROXY_METRICS.get_or_init(ProxyMetrics::default)
}

#[derive(serde::Serialize)]
pub(super) struct ProxyMetricsSnapshot {
    requests: u64,
    raw_requests: u64,
    cache_hits: u64,
    disk_cache_hits: u64,
    coalesced_requests: u64,
    upstream_requests: u64,
    upstream_retries: u64,
    upstream_errors: u64,
    network_errors: u64,
    temporary_source_errors: u64,
    unavailable_source_errors: u64,
    implementation_errors: u64,
    html_rewrites: u64,
    policy_denials: u64,
    header_deadlines: u64,
    cache_candidates: u64,
    cache_bypasses: u64,
    upstream_status_classes: [u64; 6],
    capacity: CapacityMetrics,
    memory: serde_json::Value,
}

#[derive(serde::Serialize)]
pub(super) struct CapacityMetrics {
    active: usize,
    limit: usize,
    minimum: usize,
    maximum: usize,
    peak: usize,
    waits: u64,
    rejected: u64,
}

pub async fn metrics_handler(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let metrics = proxy_metrics();
    let capacity = state.request_permit.snapshot();
    Json(ProxyMetricsSnapshot {
        requests: metrics.requests.load(Ordering::Relaxed),
        raw_requests: metrics.raw_requests.load(Ordering::Relaxed),
        cache_hits: metrics.cache_hits.load(Ordering::Relaxed),
        disk_cache_hits: metrics.disk_cache_hits.load(Ordering::Relaxed),
        coalesced_requests: metrics.coalesced_requests.load(Ordering::Relaxed),
        upstream_requests: metrics.upstream_requests.load(Ordering::Relaxed),
        upstream_retries: metrics.upstream_retries.load(Ordering::Relaxed),
        upstream_errors: metrics.upstream_errors.load(Ordering::Relaxed),
        network_errors: metrics.network_errors.load(Ordering::Relaxed),
        temporary_source_errors: metrics.temporary_source_errors.load(Ordering::Relaxed),
        unavailable_source_errors: metrics.unavailable_source_errors.load(Ordering::Relaxed),
        implementation_errors: metrics.implementation_errors.load(Ordering::Relaxed),
        html_rewrites: metrics.html_rewrites.load(Ordering::Relaxed),
        policy_denials: metrics.policy_denials.load(Ordering::Relaxed),
        header_deadlines: crate::deadline::expired(),
        cache_candidates: metrics.cache_candidates.load(Ordering::Relaxed),
        cache_bypasses: metrics.cache_bypasses.load(Ordering::Relaxed),
        upstream_status_classes: std::array::from_fn(|i| {
            metrics.upstream_statuses[i].load(Ordering::Relaxed)
        }),
        memory: state.memory_pressure.snapshot(),
        capacity: CapacityMetrics {
            active: capacity.active,
            limit: capacity.limit,
            minimum: capacity.minimum,
            maximum: capacity.maximum,
            peak: capacity.peak,
            waits: capacity.waits,
            rejected: capacity.rejected,
        },
    })
}
