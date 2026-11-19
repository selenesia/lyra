use crate::state::AppState;
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;

const EXPIRY_SWEEP_INTERVAL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct MemoryPressure {
    shedding: AtomicBool,
    budget: AtomicU64,
    available: AtomicU64,
    rejected: AtomicU64,
}

impl MemoryPressure {
    fn update(&self, budget: u64, available: u64) -> bool {
        self.budget.store(budget, Ordering::Relaxed);
        self.available.store(available, Ordering::Relaxed);
        let was_shedding = self.shedding.load(Ordering::Relaxed);
        let reserve = (budget / 10).min(256 * 1024 * 1024);
        let threshold = if was_shedding { reserve * 2 } else { reserve };
        let shedding = available <= threshold;
        self.shedding.store(shedding, Ordering::Relaxed);
        shedding
    }

    fn reject(&self, path: &str) -> Option<Response> {
        if !self.shedding.load(Ordering::Relaxed)
            || matches!(
                path,
                "/health" | "/metrics" | "/stream/metrics" | "/!!folio/metrics"
            )
        {
            return None;
        }
        self.rejected.fetch_add(1, Ordering::Relaxed);
        Some(
            (
                StatusCode::SERVICE_UNAVAILABLE,
                [("retry-after", "2"), ("cache-control", "no-store")],
                "proxy is busy, try again shortly... /ᐠ - ˕ -マ",
            )
                .into_response(),
        )
    }

    pub fn shedding(&self) -> bool {
        self.shedding.load(Ordering::Relaxed)
    }

    pub fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({
            "budget_bytes": self.budget.load(Ordering::Relaxed),
            "available_bytes": self.available.load(Ordering::Relaxed),
            "shedding": self.shedding.load(Ordering::Relaxed),
            "rejected": self.rejected.load(Ordering::Relaxed),
        })
    }
}

pub async fn admit(
    State(pressure): State<Arc<MemoryPressure>>,
    request: Request,
    next: Next,
) -> Response {
    match pressure.reject(request.uri().path()) {
        Some(response) => response,
        None => next.run(request).await,
    }
}

pub fn spawn_monitor(state: Arc<AppState>) {
    tokio::spawn(async move {
        let mut system = System::new();
        let mut ticker = tokio::time::interval(Duration::from_secs(1));
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut was_shedding = false;
        let mut last_cleanup = tokio::time::Instant::now();
        let mut last_expiry_sweep = tokio::time::Instant::now();
        loop {
            ticker.tick().await;
            if last_expiry_sweep.elapsed() >= EXPIRY_SWEEP_INTERVAL {
                last_expiry_sweep = tokio::time::Instant::now();
                state.stream_cache.run_pending_tasks().await;
            }
            system.refresh_memory();
            let (budget, available) =
                adaptive_capacity::memory_budget(system.total_memory(), system.available_memory());
            let shedding = state.memory_pressure.update(budget, available);
            let cleanup = should_cleanup(was_shedding, shedding, last_cleanup.elapsed());
            was_shedding = shedding;
            if cleanup {
                last_cleanup = tokio::time::Instant::now();
                state.cache.invalidate_all();
                state.stream_cache.invalidate_all();
                state.folio_cache.invalidate_all();
                tokio::join!(
                    state.cache.run_pending_tasks(),
                    state.stream_cache.run_pending_tasks(),
                    state.folio_cache.run_pending_tasks(),
                    crate::stream::reclaim_caches(),
                );
            }
        }
    });
}

fn should_cleanup(was_shedding: bool, shedding: bool, since_cleanup: Duration) -> bool {
    shedding && (!was_shedding || since_cleanup >= Duration::from_secs(60))
}

