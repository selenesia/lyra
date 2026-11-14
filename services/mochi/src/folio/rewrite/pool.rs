use super::protocol::{WorkerJob, WorkerReply};
use bytes::Bytes;
use std::io;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Semaphore;

const MAX_REPLY_BYTES: usize = 1024;
const RECYCLE_ABOVE_BYTES: usize = 4 * 1024 * 1024;
const FAILURES_BEFORE_COOLDOWN: u32 = 3;
const COOLDOWN: Duration = Duration::from_secs(30);

pub struct WorkerCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub struct PoolLimits {
    pub workers: usize,
    pub job_timeout: Duration,
    pub idle_timeout: Duration,
    pub queue_wait: Duration,
    pub max_payload_bytes: usize,
}

pub enum PoolOutcome {
    Done { reply: WorkerReply, payload: Bytes },
    Unavailable(&'static str),
}

struct Worker {
    _child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    idle_since: Instant,
}

pub struct RewritePool {
    command: WorkerCommand,
    limits: PoolLimits,
    permits: Semaphore,
    idle: Mutex<Vec<Worker>>,
    spawned: AtomicU64,
    failures: AtomicU32,
    cooldown_until: Mutex<Option<Instant>>,
}

async fn write_part(stdin: &mut ChildStdin, part: &[u8]) -> io::Result<()> {
    let length = u32::try_from(part.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "part is too large"))?;
    stdin.write_all(&length.to_be_bytes()).await?;
    stdin.write_all(part).await
}

async fn read_part(stdout: &mut ChildStdout, max: usize) -> io::Result<Vec<u8>> {
    let length = stdout.read_u32().await? as usize;
    if length > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "part exceeds the limit",
        ));
    }
    let mut part = vec![0u8; length];
    stdout.read_exact(&mut part).await?;
    Ok(part)
}

async fn exchange(
    worker: &mut Worker,
    job: &[u8],
    body: &[u8],
    max_payload_bytes: usize,
) -> io::Result<(WorkerReply, Bytes)> {
    write_part(&mut worker.stdin, job).await?;
    write_part(&mut worker.stdin, body).await?;
    worker.stdin.flush().await?;
    let reply = read_part(&mut worker.stdout, MAX_REPLY_BYTES).await?;
    let payload = read_part(&mut worker.stdout, max_payload_bytes).await?;
    let reply = serde_json::from_slice(&reply)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "reply is invalid"))?;
    Ok((reply, payload.into()))
}

impl RewritePool {
    pub fn new(command: WorkerCommand, limits: PoolLimits) -> Arc<Self> {
        Arc::new(Self {
            permits: Semaphore::new(limits.workers.max(1)),
            command,
            limits,
            idle: Mutex::new(Vec::new()),
            spawned: AtomicU64::new(0),
            failures: AtomicU32::new(0),
            cooldown_until: Mutex::new(None),
        })
    }

    pub fn spawned(&self) -> u64 {
        self.spawned.load(Ordering::Relaxed)
    }

    pub fn spawn_reaper(self: &Arc<Self>) {
        let pool = Arc::downgrade(self);
        let period = (self.limits.idle_timeout / 4).max(Duration::from_millis(50));
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(period).await;
                let Some(pool) = pool.upgrade() else { return };
                pool.reap_idle();
            }
        });
    }

    fn reap_idle(&self) {
        let expired = {
            let mut idle = self.idle.lock().unwrap_or_else(|lock| lock.into_inner());
            let (expired, kept) = std::mem::take(&mut *idle)
                .into_iter()
                .partition(|worker| worker.idle_since.elapsed() >= self.limits.idle_timeout);
            *idle = kept;
            expired
        };
        drop::<Vec<Worker>>(expired);
    }

    fn spawn(&self) -> io::Result<Worker> {
        let mut child = Command::new(&self.command.program)
            .args(&self.command.args)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let pipes = child.stdin.take().zip(child.stdout.take());
        let (stdin, stdout) = pipes.ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
        self.spawned.fetch_add(1, Ordering::Relaxed);
        Ok(Worker {
            _child: child,
            stdin,
            stdout,
            idle_since: Instant::now(),
        })
    }

    fn cooling_down(&self) -> bool {
        let mut until = self
            .cooldown_until
            .lock()
            .unwrap_or_else(|lock| lock.into_inner());
        match *until {
            Some(deadline) if Instant::now() < deadline => true,
            Some(_) => {
                *until = None;
                false
            }
            None => false,
        }
    }

    fn failed(&self, reason: &'static str) -> PoolOutcome {
        if self.failures.fetch_add(1, Ordering::Relaxed) + 1 >= FAILURES_BEFORE_COOLDOWN {
            self.failures.store(0, Ordering::Relaxed);
            *self
                .cooldown_until
                .lock()
                .unwrap_or_else(|lock| lock.into_inner()) = Some(Instant::now() + COOLDOWN);
        }
        PoolOutcome::Unavailable(reason)
    }

    pub async fn run(&self, job: &WorkerJob, body: &[u8]) -> PoolOutcome {
        if self.cooling_down() {
            return PoolOutcome::Unavailable("cooldown");
        }
        let Ok(job) = serde_json::to_vec(job) else {
            return PoolOutcome::Unavailable("protocol");
        };
        let Ok(Ok(_permit)) =
            tokio::time::timeout(self.limits.queue_wait, self.permits.acquire()).await
        else {
            return PoolOutcome::Unavailable("busy");
        };
        let deadline = tokio::time::Instant::now() + self.limits.job_timeout;
        let mut reused = self
            .idle
            .lock()
            .unwrap_or_else(|lock| lock.into_inner())
            .pop();
        loop {
            let was_idle = reused.is_some();
            let mut worker = match reused.take().map(Ok).unwrap_or_else(|| self.spawn()) {
                Ok(worker) => worker,
                Err(_) => return self.failed("spawn"),
            };
            let exchanged = tokio::time::timeout_at(
                deadline,
                exchange(&mut worker, &job, body, self.limits.max_payload_bytes),
            )
            .await;
            return match exchanged {
                Err(_) => self.failed("timeout"),
                Ok(Err(error)) if error.kind() == io::ErrorKind::InvalidData => {
                    self.failed("protocol")
                }
                Ok(Err(_)) if was_idle => continue,
                Ok(Err(_)) => self.failed("crashed"),
                Ok(Ok((reply, payload))) => {
                    self.failures.store(0, Ordering::Relaxed);
                    if body.len() <= RECYCLE_ABOVE_BYTES {
                        worker.idle_since = Instant::now();
                        self.idle
                            .lock()
                            .unwrap_or_else(|lock| lock.into_inner())
                            .push(worker);
                    }
                    PoolOutcome::Done { reply, payload }
                }
            };
        }
    }
}

