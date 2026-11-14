mod admission;
mod cache;
mod constants;
mod encoding;
mod deadline;
mod folio;
mod helpers;
mod memory;
mod proxy;
mod rewrite;
mod safe_dns;
mod state;
mod stream;
mod tuning;
mod upload;
mod websocket;

pub(crate) const NEGATIVE: &str = "... /ᐠ - ˕ -マ";
pub(crate) const POSITIVE: &str = "!! (˵◝ ⩊  ◜˵マ";

fn message_base(mut message: &str) -> &str {
    loop {
        if let Some(base) = message
            .strip_suffix(NEGATIVE)
            .or_else(|| message.strip_suffix(POSITIVE))
        {
            message = base.trim_end();
        } else {
            return message.trim_end_matches(['.', '!']);
        }
    }
}

pub(crate) fn negative_message(message: &str) -> String {
    format!("{}{NEGATIVE}", message_base(message))
}

use adaptive_capacity::{spawn_rebalancer, AdaptiveGate, CapacityTarget, Workload};
use aho_corasick::AhoCorasick;
use axum::http::{header::CONTENT_RANGE, Extensions, HeaderMap, StatusCode, Version};
use axum::{routing::any, Router};
use dashmap::DashMap;
use mimalloc::MiMalloc;
use moka::future::Cache;
use reqwest::{redirect::Policy, Client};
use state::{AppState, CachedResponse, FolioMetrics};
use std::error::Error;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tower_http::compression::{
    predicate::{DefaultPredicate, NotForContentType, Predicate},
    CompressionLayer,
};
use tower_http::cors::{Any, CorsLayer};

const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[global_allocator]
static GLOBAL: folio::rewrite::worker::CappedAllocator<MiMalloc> =
    folio::rewrite::worker::CappedAllocator(MiMalloc);

type AppResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

fn main() -> AppResult<()> {
    if let Some(code) = folio::rewrite::worker::run_if_requested() {
        std::process::exit(code);
    }

    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "mochi=info".into()))
        .with_ansi(false)
        .init();

    let tuning = tuning::detect();

    tracing::info!(
        "tuning: {} workers, {}mb cache cap, {}mb stream cache, {}mb max entry, {}mb stream max entry, {}mb ram limit, req permits {}/{}/{}, stream permits {}/{}/{}, rewrite permits {}/{}/{}, {}gb disk cache, {} prefetch segments",
        tuning.worker_threads,
        tuning.cache_capacity_bytes / (1024 * 1024),
        tuning.stream_cache_capacity_bytes / (1024 * 1024),
        tuning.max_cache_entry_size / (1024 * 1024),
        tuning.stream_max_entry_size / (1024 * 1024),
        tuning.ram_cache_limit / (1024 * 1024),
        tuning.request_permits_min,
        tuning.request_permits,
        tuning.request_permits_max,
        tuning.stream_upstream_permits_min,
        tuning.stream_upstream_permits,
        tuning.stream_upstream_permits_max,
        tuning.html_rewrite_permits_min,
        tuning.html_rewrite_permits,
        tuning.html_rewrite_permits_max,
        tuning.disk_cache_bytes / (1024 * 1024 * 1024),
        tuning.stream_prefetch_segments,
    );

    tracing::info!(
        "folio rewrite: {} workers, {}mb cache, {}mb max script",
        tuning.folio_rewrite_workers,
        tuning.folio_rewrite_cache_bytes / (1024 * 1024),
        tuning.folio_rewrite_max_bytes / (1024 * 1024),
    );

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(tuning.worker_threads)
        .enable_all()
        .build()?;

    runtime.block_on(async_main(tuning))
}

fn upstream_client(pool_idle_timeout_secs: u64) -> reqwest::ClientBuilder {
    Client::builder()
        .no_proxy()
        .retry(reqwest::retry::never())
        .user_agent(BROWSER_USER_AGENT)
        .dns_resolver(Arc::new(safe_dns::PublicDnsResolver))
        .pool_idle_timeout(Duration::from_secs(pool_idle_timeout_secs))
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .http2_adaptive_window(true)
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(20))
}

fn folio_rewriter(tuning: &tuning::MochiTuning) -> Option<Arc<folio::rewrite::FolioRewriter>> {
    use folio::rewrite::{pool, worker, FolioRewriter};
    if tuning.folio_rewrite_workers == 0 {
        return None;
    }
    let program = if cfg!(target_os = "linux") {
        "/proc/self/exe".into()
    } else {
        match std::env::current_exe() {
            Ok(program) => program,
            Err(_) => {
                tracing::warn!("folio rewrite workers are unavailable{}", NEGATIVE);
                return None;
            }
        }
    };
    let rewrite_pool = pool::RewritePool::new(
        pool::WorkerCommand {
            program,
            args: vec![
                worker::WORKER_ARG.into(),
                tuning.folio_rewrite_worker_heap_bytes.to_string(),
            ],
        },
        pool::PoolLimits {
            workers: tuning.folio_rewrite_workers,
            job_timeout: Duration::from_millis(tuning.folio_rewrite_timeout_ms),
            idle_timeout: Duration::from_secs(5 * 60),
            queue_wait: Duration::from_secs(2),
            max_payload_bytes: tuning.folio_rewrite_max_bytes * 4 + 1024 * 1024,
        },
    );
    rewrite_pool.spawn_reaper();
    Some(FolioRewriter::new(
        rewrite_pool,
        tuning.folio_rewrite_cache_bytes,
        tuning.folio_rewrite_max_bytes,
    ))
}

async fn async_main(tuning: tuning::MochiTuning) -> AppResult<()> {
    tokio::fs::create_dir_all("./cache/stream").await?;

    let cache = Cache::builder()
        .max_capacity(tuning.cache_capacity_bytes)
        .weigher(|_key: &String, response: &Arc<CachedResponse>| -> u32 {
            (response.body.len() as u32).saturating_add(200)
        })
        .time_to_live(Duration::from_secs(tuning.cache_ttl_secs))
        .build();

    let stream_cache = Cache::builder()
        .max_capacity(tuning.stream_cache_capacity_bytes)
        .weigher(|_key: &String, response: &Arc<CachedResponse>| -> u32 {
            (response.body.len() as u32).saturating_add(256)
        })
        .time_to_live(Duration::from_secs(tuning.cache_ttl_secs))
        .build();

    let stream_fills = Cache::builder()
        .max_capacity(20_000)
        .time_to_idle(Duration::from_secs(10 * 60))
        .build();

    let folio_cache = Cache::builder()
        .max_capacity((tuning.cache_capacity_bytes / 2).max(64 * 1024 * 1024))
        .weigher(
            |key: &String, response: &Arc<state::FolioCachedResponse>| -> u32 {
                response.cache_weight(key)
            },
        )
        .time_to_live(Duration::from_secs(tuning.cache_ttl_secs))
        .build();

    let asset_client = upstream_client(tuning.pool_idle_timeout_secs)
        .redirect(safe_dns::redirect_policy())
        .pool_max_idle_per_host(tuning.pool_idle_per_host_asset)
        .read_timeout(Duration::from_secs(60))
        .build()?;

    let html_client = upstream_client(tuning.pool_idle_timeout_secs)
        .redirect(safe_dns::redirect_policy())
        .pool_max_idle_per_host(tuning.pool_idle_per_host_html)
        .read_timeout(Duration::from_secs(60))
        .build()?;

    let raw_client = upstream_client(tuning.pool_idle_timeout_secs)
        .redirect(Policy::none())
        .pool_max_idle_per_host(tuning.pool_idle_per_host_asset)
        .read_timeout(Duration::from_secs(120))
        .build()?;

    let folio_client = wreq::Client::builder()
        .emulation(wreq_util::Profile::Chrome149)
        .no_proxy()
        .retry(wreq::retry::Policy::never())
        .dns_resolver(Arc::new(safe_dns::PublicDnsResolver))
        .redirect(wreq::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(tuning.pool_idle_timeout_secs))
        .pool_max_idle_per_host(tuning.pool_idle_per_host_asset)
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(120))
        .build()?;

    let patterns = [
        "google-analytics.com",
        "googletagmanager.com",
        "doubleclick.net",
        "adsbygoogle",
        "js.rev.iq",
        "motorsnag.com",
        "monetag",
        "netpub",
    ];
    let blocklist_matcher = Arc::new(AhoCorasick::new(patterns)?);

    let request_permit = AdaptiveGate::new(
        tuning.request_permits_min,
        tuning.request_permits,
        tuning.request_permits_max,
    );
    let stream_upstream_permit = AdaptiveGate::new(
        tuning.stream_upstream_permits_min,
        tuning.stream_upstream_permits,
        tuning.stream_upstream_permits_max,
    );
    let html_rewrite_permit = AdaptiveGate::new(
        tuning.html_rewrite_permits_min,
        tuning.html_rewrite_permits,
        tuning.html_rewrite_permits_max,
    );

    spawn_rebalancer(
        vec![
            CapacityTarget::new(
                request_permit.clone(),
                tuning.ram_cache_limit as u64,
                Workload::Io,
            ),
            CapacityTarget::new(
                stream_upstream_permit.clone(),
                tuning.ram_cache_limit as u64,
                Workload::Io,
            ),
            CapacityTarget::new(
                html_rewrite_permit.clone(),
                (16 * 1024 * 1024) as u64,
                Workload::Cpu,
            ),
        ],
        Duration::from_secs(2),
    );

    let state = Arc::new(AppState {
        websocket_permit: Arc::new(tokio::sync::Semaphore::new(admission::limit(
            "MOCHI_WEBSOCKETS",
            256,
        ))),
        memory_pressure: Arc::new(memory::MemoryPressure::default()),
        html_client,
        asset_client,
        raw_client,
        folio_client,
        cache,
        stream_cache,
        stream_fills,
        folio_cache,
        effective_bases: Cache::builder()
            .max_capacity(4096)
            .time_to_live(Duration::from_secs(600))
            .build(),
        folio_cache_generation: Default::default(),
        folio_metrics: FolioMetrics::default(),
        folio_rewriter: folio_rewriter(&tuning),
        blocklist_matcher,
        caching_inflight: DashMap::new(),
        coalesce: DashMap::new(),
        request_permit,
        stream_upstream_permit,
        html_rewrite_permit,
        max_cache_entry_size: tuning.max_cache_entry_size,
        disk_cache_max_age_secs: tuning.disk_max_age_secs,
        folio_cache_max_entry_size: tuning.max_cache_entry_size.min(8 * 1024 * 1024),
        folio_cache_max_ttl_secs: tuning.cache_ttl_secs,
        stream_max_entry_size: tuning.stream_max_entry_size,
        ram_cache_limit: tuning.ram_cache_limit,
        channel_buffer: tuning.channel_buffer,
        stream_prefetch_segments: tuning.stream_prefetch_segments,
    });

    memory::spawn_monitor(state.clone());

    let port = std::env::var("MOCHI_PORT").unwrap_or_else(|_| "4002".to_string());
    let port = port.parse::<u16>().unwrap_or(4002);
    let host = std::env::var("MOCHI_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let host = host
        .parse::<std::net::IpAddr>()
        .map_err(|_| "invalid mochi bind address... /ᐠ - ˕ -マ")?;
    let addr = SocketAddr::from((host, port));
    tracing::info!("mochi listening on {}{}", addr, POSITIVE);

    tokio::spawn(cache::disk_cache_cleanup_task(
        tuning.disk_cache_bytes,
        tuning.disk_max_age_secs,
        tuning.disk_cleanup_interval_secs,
    ));

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let compression_predicate = DefaultPredicate::new()
        .and(NotForContentType::const_new("video/"))
        .and(NotForContentType::const_new("audio/"))
        .and(
            |status: StatusCode,
             _version: Version,
             headers: &HeaderMap,
             _extensions: &Extensions| {
                status != StatusCode::PARTIAL_CONTENT && !headers.contains_key(CONTENT_RANGE)
            },
        );

    let app = Router::new()
        .route("/health", axum::routing::get(|| async { "oki" }))
        .route("/metrics", axum::routing::get(proxy::metrics_handler))
        .route(
            &format!("{}capabilities", folio::PREFIX),
            axum::routing::get(folio::capabilities_handler),
        )
        .route(
            &format!("{}metrics", folio::PREFIX),
            axum::routing::get(folio::metrics_handler),
        )
        .route(
            &format!("{}*target", folio::REQUEST_PREFIX),
            any(folio::request_handler),
        )
        .route(
            "/stream/metrics",
            axum::routing::get(stream::stream_metrics_handler),
        )
        .route(
            "/stream/info",
            axum::routing::get({
                let state = state.clone();
                move |method: axum::http::Method,
                      uri: axum::http::Uri,
                      headers: axum::http::HeaderMap| {
                    let state = state.clone();
                    async move { stream::stream_info_handler(state, method, uri, headers).await }
                }
            }),
        )
        .route(
            "/stream/*path",
            axum::routing::any({
                let state = state.clone();
                move |method: axum::http::Method,
                      uri: axum::http::Uri,
                      headers: axum::http::HeaderMap| {
                    let state = state.clone();
                    async move { stream::stream_handler(state, method, uri, headers).await }
                }
            }),
        )
        .route(
            &format!("{}*key", constants::MOCHI_RAW_PREFIX),
            any(proxy::raw_proxy_handler),
        )
        .route(
            &format!("{}*key", constants::MOCHI_PREFIX),
            any(proxy::proxy_handler),
        )
        .route("/", any(proxy::proxy_handler))
        .route("/*path", any(proxy::proxy_handler))
        .fallback(any(proxy::proxy_handler))
        .layer(axum::middleware::from_fn_with_state(
            state.memory_pressure.clone(),
            memory::admit,
        ))
        .layer(CompressionLayer::new().compress_when(compression_predicate))
        .layer(cors)
        .layer(axum::middleware::from_fn_with_state(
            admission::Admission::from_env(),
            admission::admit,
        ))
        .layer(axum::middleware::from_fn(deadline::headers))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .tcp_nodelay(true)
    .with_graceful_shutdown(async {
        shutdown_signal().await;
        tracing::info!("shutting down...");
    })
    .await?;
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
