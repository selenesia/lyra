mod admission;
mod auth;
mod db;
mod opaque;
mod sync;
mod tuning;

use adaptive_capacity::{spawn_rebalancer, AdaptiveGate, CapacityTarget, Workload};
use aes_gcm::{aead::KeyInit, Aes256Gcm};
use axum::body::Body;
use axum::extract::DefaultBodyLimit;
use axum::http::{
    header::{REFERRER_POLICY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS, X_XSS_PROTECTION},
    HeaderValue, StatusCode,
};
use axum::{response::Response, Router};
use mimalloc::MiMalloc;
use sha2::{Digest, Sha256};
use std::net::SocketAddr;
use std::sync::Arc;
use tower_governor::{
    governor::GovernorConfigBuilder, key_extractor::SmartIpKeyExtractor, GovernorError,
    GovernorLayer,
};
use tower_http::set_header::SetResponseHeaderLayer;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};
use zeroize::Zeroizing;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

const NEGATIVE: &str = "... /ᐠ - ˕ -マ";
const POSITIVE: &str = "!! (˵◝ ⩊  ◜˵マ";

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

fn negative_message(message: &str) -> String {
    format!("{}{NEGATIVE}", message_base(message))
}

fn positive_message(message: &str) -> String {
    format!("{}{POSITIVE}", message_base(message))
}

fn required_secret(name: &str, minimum_bytes: usize) -> Zeroizing<String> {
    let value =
        std::env::var(name).unwrap_or_else(|_| panic!("required secret is missing... /ᐠ - ˕ -マ"));
    if value.len() < minimum_bytes {
        panic!("required secret is too short... /ᐠ - ˕ -マ");
    }
    Zeroizing::new(value)
}

fn governor_response(error: GovernorError) -> Response {
    let (status, headers, message) = match error {
        GovernorError::TooManyRequests { headers, .. } => (
            axum::http::StatusCode::TOO_MANY_REQUESTS,
            headers,
            negative_message("too many requests"),
        ),
        GovernorError::UnableToExtractKey => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            None,
            negative_message("request could not be processed"),
        ),
        GovernorError::Other { code, headers, .. } => (
            code,
            headers,
            negative_message("request could not be processed"),
        ),
    };
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    if let Some(headers) = headers {
        response.headers_mut().extend(headers);
    }
    response
}

#[tokio::main]
async fn main() {
    dotenvy::dotenv().ok();
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "cloudsync=debug,tower_http=debug".into()),
        ))
        .with(tracing_subscriber::fmt::layer().with_ansi(false))
        .init();

    let tuning = tuning::detect();
    tracing::info!(
        "tuning: pool_max={}, pool_min_idle={}, auth_work={}/{}/{}, sync_work={}/{}/{}, cache_kb={}, mmap_mb={}, body_limit={}mb",
        tuning.db_pool_max,
        tuning.db_pool_min_idle,
        tuning.auth_work_min,
        tuning.auth_work_permits,
        tuning.auth_work_max,
        tuning.sync_work_min,
        tuning.sync_work_permits,
        tuning.sync_work_max,
        tuning.db_cache_size_kb,
        tuning.db_mmap_size / (1024 * 1024),
        tuning.body_limit_mb
    );

    let pool = match db::init_pool(
        tuning.db_pool_max,
        tuning.db_pool_min_idle,
        tuning.db_cache_size_kb,
        tuning.db_mmap_size,
    ) {
        Ok(pool) => pool,
        Err(error) => {
            tracing::error!(
                "failed to initialize database pool: {}... /ᐠ - ˕ -マ",
                error
            );
            std::process::exit(1);
        }
    };

    let jwt_secret = required_secret("JWT_SECRET", 64);
    let sync_secret = required_secret("SYNC_SECRET", 32);
    if jwt_secret.as_str() == sync_secret.as_str() {
        panic!("authentication and sync secrets must be different... /ᐠ - ˕ -マ");
    }
    let mut hasher = Sha256::new();
    hasher.update(sync_secret.as_bytes());
    let key_bytes = hasher.finalize();
    let aes_key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_bytes);
    let aes_cipher = std::sync::Arc::new(Aes256Gcm::new(aes_key));

    let auth_work = AdaptiveGate::new(
        tuning.auth_work_min,
        tuning.auth_work_permits,
        tuning.auth_work_max,
    );
    let sync_work = AdaptiveGate::new(
        tuning.sync_work_min,
        tuning.sync_work_permits,
        tuning.sync_work_max,
    );
    spawn_rebalancer(
        vec![
            CapacityTarget::new(auth_work.clone(), 24 * 1024 * 1024, Workload::Cpu),
            CapacityTarget::new(sync_work.clone(), 80 * 8 * 1024 * 1024, Workload::Mixed),
        ],
        std::time::Duration::from_secs(2),
    );

    let state = Arc::new(auth::AppState {
        jwt_secret,
        pool: pool.clone(),
        aes_cipher,
        auth_work,
        sync_work,
        sync_admission: admission::Admission::new(),
        opaque_setup: Arc::new(opaque::server_setup_from_env()),
    });

    auth::warm_password_verifier();

    let checkpoint_pool = pool.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(300));
        interval.tick().await;
        loop {
            interval.tick().await;
            let pool = checkpoint_pool.clone();
            let started = std::time::Instant::now();
            let outcome =
                tokio::task::spawn_blocking(move || -> Result<(i64, i64, i64), &'static str> {
                    let conn = pool.get().map_err(|_| "pool")?;
                    sync::transfer::cleanup(&conn).map_err(|_| "cleanup")?;
                    conn.query_row("PRAGMA wal_checkpoint(PASSIVE)", [], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    })
                    .map_err(|_| "checkpoint")
                })
                .await;
            let elapsed_ms = started.elapsed().as_millis() as u64;
            match outcome {
                Ok(Ok((busy, wal_pages, checkpointed_pages))) => tracing::info!(
                    busy,
                    wal_pages,
                    checkpointed_pages,
                    elapsed_ms,
                    "database maintenance sample"
                ),
                Ok(Err(stage)) => tracing::warn!(
                    stage,
                    elapsed_ms,
                    "database maintenance failed... /ᐠ - ˕ -マ"
                ),
                Err(_) => {
                    tracing::warn!(elapsed_ms, "database maintenance task failed... /ᐠ - ˕ -マ")
                }
            }
        }
    });

    let strict_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_second(2)
            .burst_size(5)
            .error_handler(governor_response)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let auth_read_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_millisecond(50)
            .burst_size(100)
            .error_handler(governor_response)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let username_check_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_millisecond(250)
            .burst_size(12)
            .error_handler(governor_response)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let sync_write_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_millisecond(500)
            .burst_size(10)
            .error_handler(governor_response)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let sync_read_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_millisecond(20)
            .burst_size(200)
            .error_handler(governor_response)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );
    let sync_chunk_conf = Box::new(
        GovernorConfigBuilder::default()
            .per_millisecond(25)
            .burst_size(64)
            .error_handler(governor_response)
            .key_extractor(SmartIpKeyExtractor)
            .finish()
            .unwrap(),
    );

    let auth_routes_strict = Router::new()
        .route(
            "/register/start",
            axum::routing::post(opaque::register_start),
        )
        .route(
            "/register/finish",
            axum::routing::post(opaque::register_finish),
        )
        .route("/login", axum::routing::post(auth::login))
        .route("/login/start", axum::routing::post(opaque::login_start))
        .route("/login/finish", axum::routing::post(opaque::login_finish))
        .route("/upgrade/start", axum::routing::post(opaque::upgrade_start))
        .route(
            "/upgrade/finish",
            axum::routing::post(opaque::upgrade_finish),
        )
        .route("/me", axum::routing::delete(auth::delete_account))
        .layer(DefaultBodyLimit::max(2048))
        .layer(GovernorLayer {
            config: strict_conf.into(),
        });

    let auth_routes_username = Router::new()
        .route("/username", axum::routing::get(auth::username_available))
        .layer(GovernorLayer {
            config: username_check_conf.into(),
        });

    let auth_routes_loose = Router::new()
        .route("/logout", axum::routing::post(auth::logout))
        .route("/me", axum::routing::get(auth::me))
        .route("/metrics", axum::routing::get(auth::metrics))
        .layer(GovernorLayer {
            config: auth_read_conf.into(),
        });

    let sync_write_routes = Router::new()
        .route("/upload", axum::routing::post(sync::upload))
        .route("/transfer", axum::routing::post(sync::transfer::begin))
        .route(
            "/transfer/:id/commit",
            axum::routing::post(sync::transfer::commit),
        )
        .layer(GovernorLayer {
            config: sync_write_conf.into(),
        });

    let sync_read_routes = Router::new()
        .route("/download", axum::routing::get(sync::download))
        .route("/meta", axum::routing::get(sync::meta))
        .route("/transfer", axum::routing::get(sync::transfer::manifest))
        .layer(GovernorLayer {
            config: sync_read_conf.into(),
        });

    let sync_chunk_routes = Router::new()
        .route(
            "/transfer/:id/:part",
            axum::routing::put(sync::transfer::put).get(sync::transfer::get),
        )
        .layer(DefaultBodyLimit::max(sync::transfer::CHUNK_SIZE))
        .layer(GovernorLayer {
            config: sync_chunk_conf.into(),
        });

    let api_routes = Router::new()
        .nest(
            "/auth",
            auth_routes_strict
                .merge(auth_routes_username)
                .merge(auth_routes_loose),
        )
        .nest(
            "/sync",
            sync_write_routes
                .merge(sync_read_routes)
                .merge(sync_chunk_routes),
        )
        .with_state(state)
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store, no-cache, must-revalidate, proxy-revalidate"),
        ));

    let app = Router::new()
        .nest("/api", api_routes)
        .route(
            "/",
            axum::routing::get(|| async { positive_message("cloudsync active") }),
        )
        .route(
            "/health",
            axum::routing::get({
                let health_pool = pool.clone();
                move || {
                    let pool_ok = health_pool.try_get().is_some();
                    async move {
                        if pool_ok {
                            (StatusCode::OK, "oki")
                        } else {
                            (StatusCode::SERVICE_UNAVAILABLE, "oki")
                        }
                    }
                }
            }),
        )
        .layer(tower_cookies::CookieManagerLayer::new())
        .layer(SetResponseHeaderLayer::overriding(
            X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            X_XSS_PROTECTION,
            HeaderValue::from_static("1; mode=block"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            REFERRER_POLICY,
            HeaderValue::from_static("strict-origin-when-cross-origin"),
        ))
        .layer(DefaultBodyLimit::max(tuning.body_limit_mb * 1024 * 1024));

    let port = std::env::var("CLOUDSYNC_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4005);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("cloudsync listening on {}{}", addr, POSITIVE);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("failed to bind cloudsync listener... /ᐠ - ˕ -マ");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = tokio::signal::ctrl_c().await;
        tracing::info!("shutting down...");
    })
    .await
    .expect("cloudsync server failed... /ᐠ - ˕ -マ");
}
