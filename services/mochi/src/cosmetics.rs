pub mod catalog;
pub mod serve;
pub mod sync;

pub use serve::Cosmetics;

use crate::NEGATIVE;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub const PREFIX: &str = "/!!cosmetics/";
pub const SYNC_ARG: &str = "--cosmetics-sync";

#[derive(Clone, Debug)]
pub struct Config {
    pub dir: PathBuf,
    pub source: Option<PathBuf>,
    pub prefetch: bool,
    pub refresh: Option<Duration>,
}

fn env_text(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_owned()).filter(|value| !value.is_empty())
}

impl Config {
    pub fn from_env() -> Self {
        let dir = env_text("MOCHI_COSMETICS_DIR").map_or_else(|| PathBuf::from("./cache/cosmetics"), PathBuf::from);
        let source = env_text("MOCHI_COSMETICS_SOURCE").map_or_else(|| dir.join("source.json"), PathBuf::from);
        let refresh = env_text("MOCHI_COSMETICS_REFRESH_HOURS")
            .and_then(|hours| hours.parse::<f64>().ok())
            .filter(|hours| hours.is_finite() && *hours > 0.0)
            .map(|hours| Duration::from_secs_f64((hours * 3600.0).max(60.0)));
        Self {
            dir,
            source: Some(source),
            prefetch: env_text("MOCHI_COSMETICS_PREFETCH").as_deref() == Some("1"),
            refresh,
        }
    }
}

pub fn client() -> reqwest::Result<reqwest::Client> {
    crate::upstream_client(90)
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(16)
        .read_timeout(Duration::from_secs(60))
        .build()
}

pub fn run_if_requested() -> Option<i32> {
    if !std::env::args().skip(1).any(|arg| arg == SYNC_ARG) {
        return None;
    }
    let runtime = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(runtime) => runtime,
        Err(_) => {
            tracing::error!("cosmetics sync could not start{NEGATIVE}");
            return Some(1);
        }
    };
    let config = Config { prefetch: true, ..Config::from_env() };
    Some(runtime.block_on(async move {
        let Ok(client) = client() else {
            tracing::error!("cosmetics sync could not start{NEGATIVE}");
            return 1;
        };
        match sync::run(&config, &client).await {
            Ok(report) if report.missing > 0 => 2,
            Ok(_) => 0,
            Err(error) => {
                tracing::error!(%error, "cosmetics sync failed{NEGATIVE}");
                1
            }
        }
    }))
}

pub fn spawn_refresh(cosmetics: Arc<Cosmetics>) {
    let Some(every) = cosmetics.config.refresh else {
        return;
    };
    tokio::spawn(async move {
        loop {
            if let Err(error) = sync::run(&cosmetics.config, &cosmetics.client).await {
                tracing::warn!(%error, "cosmetics refresh failed{NEGATIVE}");
            }
            tokio::time::sleep(every).await;
        }
    });
}

