use adaptive_capacity::{AdaptiveGate, AdaptivePermit};
use dashmap::{mapref::entry::Entry, DashMap};
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

const QUEUE_LIMIT: usize = 32;
const WAIT_LIMIT: Duration = Duration::from_secs(2);
pub const ACCOUNT_CHUNK_LIMIT: u8 = 8;

#[derive(Default)]
struct AccountSlots {
    snapshot: bool,
    chunks: u8,
}

#[derive(Clone, Copy)]
pub enum Operation {
    Read,
    Write,
    Snapshot,
}
impl Operation {
    fn index(self) -> usize {
        match self {
            Self::Read => 0,
            Self::Write => 1,
            Self::Snapshot => 2,
        }
    }
}
#[derive(Default)]
struct Counters {
    accepted: AtomicU64,
    rejected: AtomicU64,
    completed: AtomicU64,
    elapsed_ms: AtomicU64,
    durations: [AtomicU64; 5],
}

pub struct Admission {
    pub chunks: Arc<AdaptiveGate>,
    writers: Arc<AdaptiveGate>,
    queue: Arc<Semaphore>,
    users: DashMap<i64, AccountSlots>,
    counters: [Counters; 3],
}

impl Admission {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            chunks: AdaptiveGate::new(2, 16, 32),
            writers: AdaptiveGate::new(1, 2, 4),
            queue: Arc::new(Semaphore::new(QUEUE_LIMIT)),
            users: DashMap::new(),
            counters: Default::default(),
        })
    }

    pub async fn acquire(
        self: &Arc<Self>,
        user_id: i64,
        operation: Operation,
        snapshots: &Arc<AdaptiveGate>,
    ) -> Option<Permit> {
        let counters = &self.counters[operation.index()];
        let queued = match self.queue.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                counters.rejected.fetch_add(1, Ordering::Relaxed);
                return None;
            }
        };
        let exclusive = matches!(operation, Operation::Snapshot);
        let reserved = match self.users.entry(user_id) {
            Entry::Occupied(mut entry) => {
                let slots = entry.get_mut();
                let available = !exclusive && !slots.snapshot && slots.chunks < ACCOUNT_CHUNK_LIMIT;
                if available {
                    slots.chunks += 1;
                }
                available
            }
            Entry::Vacant(entry) => {
                entry.insert(AccountSlots {
                    snapshot: exclusive,
                    chunks: u8::from(!exclusive),
                });
                true
            }
        };
        if !reserved {
            counters.rejected.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        let mut permit = Permit {
            admission: self.clone(),
            user_id,
            operation,
            gate: None,
            started: Instant::now(),
        };
        let gate = match operation {
            Operation::Snapshot => snapshots,
            Operation::Write => &self.writers,
            Operation::Read => &self.chunks,
        };
        permit.gate = gate.acquire_timeout(WAIT_LIMIT).await;
        drop(queued);
        if permit.gate.is_none() {
            counters.rejected.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        counters.accepted.fetch_add(1, Ordering::Relaxed);
        Some(permit)
    }

    pub fn metrics(&self) -> serde_json::Value {
        let values: Vec<_> = ["read", "write", "snapshot"].iter().zip(&self.counters).map(|(name, counter)| serde_json::json!({
            "operation": name,
            "accepted": counter.accepted.load(Ordering::Relaxed),
            "rejected": counter.rejected.load(Ordering::Relaxed),
            "completed": counter.completed.load(Ordering::Relaxed),
            "elapsed_ms": counter.elapsed_ms.load(Ordering::Relaxed),
            "duration_buckets": counter.durations.iter().map(|value| value.load(Ordering::Relaxed)).collect::<Vec<_>>(),
            "duration_bounds_ms": [10, 100, 1000, 5000],
        })).collect();
        let gate = self.chunks.snapshot();
        serde_json::json!({"operations": values, "chunks": {"active": gate.active, "limit": gate.limit, "peak": gate.peak, "waits": gate.waits, "rejected": gate.rejected}, "queued": QUEUE_LIMIT - self.queue.available_permits(), "accounts": self.users.len()})
    }
}

pub struct Permit {
    admission: Arc<Admission>,
    user_id: i64,
    operation: Operation,
    gate: Option<AdaptivePermit>,
    started: Instant,
}
impl Drop for Permit {
    fn drop(&mut self) {
        self.admission
            .users
            .remove_if_mut(&self.user_id, |_, slots| {
                if matches!(self.operation, Operation::Snapshot) {
                    slots.snapshot = false;
                } else {
                    slots.chunks = slots.chunks.saturating_sub(1);
                }
                !slots.snapshot && slots.chunks == 0
            });
        if self.gate.is_some() {
            let elapsed = self.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            let counter = &self.admission.counters[self.operation.index()];
            counter.completed.fetch_add(1, Ordering::Relaxed);
            counter.elapsed_ms.fetch_add(elapsed, Ordering::Relaxed);
            let bucket = [10, 100, 1000, 5000]
                .iter()
                .position(|bound| elapsed <= *bound)
                .unwrap_or(4);
            counter.durations[bucket].fetch_add(1, Ordering::Relaxed);
        }
    }
}

