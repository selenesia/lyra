use super::*;

pub(super) struct SegmentProgress {
    chunks: Vec<Bytes>,
    end: Option<bool>,
}

pub(crate) struct LiveSegment {
    headers: HeaderMap,
    len: usize,
    progress: watch::Sender<SegmentProgress>,
    joinable: std::sync::Mutex<bool>,
}

impl LiveSegment {
    fn new(headers: HeaderMap, len: usize) -> Self {
        Self {
            headers,
            len,
            progress: watch::Sender::new(SegmentProgress {
                chunks: Vec::new(),
                end: None,
            }),
            joinable: std::sync::Mutex::new(true),
        }
    }

    fn subscribe(&self) -> Option<watch::Receiver<SegmentProgress>> {
        let joinable = self
            .joinable
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (*joinable && self.progress.borrow().end != Some(false)).then(|| self.progress.subscribe())
    }

    fn close_if_unread(&self) -> bool {
        let mut joinable = self
            .joinable
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.progress.receiver_count() == 0 {
            *joinable = false;
        }
        !*joinable
    }

    fn body(&self, receiver: watch::Receiver<SegmentProgress>) -> Body {
        let len = self.len;
        let metrics = DownstreamBodyMetrics {
            expected: len as u64,
            yielded: 0,
            failed: false,
        };
        let stream = futures_util::stream::unfold(
            Some((receiver, 0usize, metrics)),
            move |reader| async move {
                let (mut receiver, mut index, mut metrics) = reader?;
                loop {
                    if metrics.yielded >= len as u64 {
                        return None;
                    }
                    let next = {
                        let progress = receiver.borrow_and_update();
                        match progress.chunks.get(index) {
                            Some(chunk) => Some(Some(chunk.clone())),
                            None if progress.end.is_some() => Some(None),
                            None => None,
                        }
                    };
                    let item = match next {
                        Some(Some(chunk)) => Ok(chunk),
                        None => {
                            if receiver.changed().await.is_ok() {
                                continue;
                            }
                            Err(())
                        }
                        Some(None) => Err(()),
                    }
                    .map_err(|()| {
                        std::io::Error::other("upstream media stream failed... /ᐠ - ˕ -マ")
                    });
                    metrics.observe(&item);
                    index += 1;
                    let failed = item.is_err();
                    return Some((item, (!failed).then_some((receiver, index, metrics))));
                }
            },
        );
        Body::from_stream(stream)
    }

    fn contents(&self) -> Bytes {
        let progress = self.progress.borrow();
        if let [chunk] = progress.chunks.as_slice() {
            return chunk.clone();
        }
        let mut body = BytesMut::with_capacity(self.len);
        for chunk in &progress.chunks {
            body.extend_from_slice(chunk);
        }
        body.freeze()
    }
}

pub(super) fn join_live_segment(slot: &StreamFill) -> Option<Response> {
    let live = slot
        .live
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()?;
    let receiver = live.subscribe()?;
    let mut headers = live.headers.clone();
    headers.insert("X-Cache", CacheStatus::Coalesced.header());
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let mut response = Response::new(live.body(receiver));
    *response.headers_mut() = headers;
    Some(response)
}

pub(super) struct SegmentFill {
    pub(super) cacheable: bool,
    pub(super) cache_key: String,
    pub(super) cache: Cache<String, Arc<CachedResponse>>,
    pub(super) headers: HeaderMap,
    pub(super) expected_len: Option<usize>,
    pub(super) max_entry_size: usize,
    pub(super) ram_limit: usize,
    pub(super) ram: Option<BytesMut>,
    pub(super) live: Option<Arc<LiveSegment>>,
    pub(super) detached: bool,
    pub(super) disk: Option<StreamCacheWriter>,
    pub(super) disk_failed: bool,
    pub(super) sender: Option<mpsc::Sender<std::io::Result<Bytes>>>,
    pub(super) downstream_cancelled: bool,
    pub(super) bytes: usize,
}

impl SegmentFill {
    pub(super) async fn push(&mut self, chunk: Bytes) -> Result<(), ResolveError> {
        let next_len = self
            .bytes
            .checked_add(chunk.len())
            .ok_or(ResolveError::TooLarge)?;
        if next_len > self.max_entry_size {
            return Err(ResolveError::TooLarge);
        }
        self.bytes = next_len;

        if let Some(sender) = self.sender.as_ref() {
            if sender.send(Ok(chunk.clone())).await.is_err() {
                self.sender = None;
                self.record_downstream_cancellation();
                return Err(ResolveError::Upstream);
            } else {
                STREAM_METRICS
                    .bytes_served
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
        }
        if let Some(live) = self.live.as_ref() {
            if next_len > live.len {
                return Err(ResolveError::Upstream);
            }
            live.progress
                .send_modify(|progress| progress.chunks.push(chunk.clone()));
        }

        if let Some(writer) = self.disk.as_mut() {
            if writer.write(&chunk).await.is_err() {
                self.disk.take();
                self.disk_failed = true;
            }
        }
        if let Some(ram) = self.ram.as_mut() {
            if next_len > self.ram_limit {
                self.ram = None;
            } else {
                ram.extend_from_slice(&chunk);
            }
        }
        Ok(())
    }

    fn record_downstream_cancellation(&mut self) {
        if !self.downstream_cancelled {
            self.downstream_cancelled = true;
            if self.live.is_none() {
                STREAM_METRICS
                    .downstream_cancellations
                    .fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    async fn downstream_closed(&self) {
        match (&self.sender, &self.live) {
            (Some(sender), _) => sender.closed().await,
            (None, Some(live)) if !self.detached && self.bytes < live.len => {
                live.progress.closed().await
            }
            _ => std::future::pending().await,
        }
    }

    async fn fail_downstream(&mut self) {
        if let Some(sender) = self.sender.take() {
            let error = std::io::Error::other("upstream media stream failed... /ᐠ - ˕ -マ");
            if !matches!(
                tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, sender.send(Err(error))).await,
                Ok(Ok(()))
            ) {
                self.record_downstream_cancellation();
            }
        }
    }

    pub(super) async fn finish(&mut self) -> Result<(), ResolveError> {
        if self
            .expected_len
            .is_some_and(|expected| expected != self.bytes)
        {
            return Err(ResolveError::Upstream);
        }
        self.sender.take();
        self.headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&self.bytes.to_string()).map_err(|_| ResolveError::Upstream)?,
        );

        let mut published = false;
        if let Some(writer) = self.disk.take() {
            if writer.commit().await.is_ok() {
                published = true;
            } else {
                self.disk_failed = true;
            }
        }
        if self.disk_failed {
            STREAM_METRICS
                .segment_disk_write_failures
                .fetch_add(1, Ordering::Relaxed);
        }
        let body = match (self.ram.take(), self.live.as_ref()) {
            (Some(ram), _) => Some(ram.freeze()),
            (None, Some(live)) => Some(live.contents()),
            (None, None) => None,
        };
        if let Some(body) = body {
            let cached = Arc::new(CachedResponse {
                status: StatusCode::OK.as_u16(),
                headers: self.headers.clone(),
                body,
            });
            self.cache.insert(self.cache_key.clone(), cached).await;
            published = true;
        }
        (published || !self.cacheable)
            .then_some(())
            .ok_or(ResolveError::Upstream)
    }
}

pub(super) async fn fill_from_stream(
    fill: &mut SegmentFill,
    chunks: impl futures_util::Stream<Item = Result<Bytes, reqwest::Error>>,
) -> Result<(), ResolveError> {
    futures_util::pin_mut!(chunks);
    loop {
        let chunk = tokio::select! {
            biased;
            _ = fill.downstream_closed() => {
                if fill.live.as_ref().is_some_and(|live| !live.close_if_unread()) {
                    continue;
                }
                fill.record_downstream_cancellation();
                return Err(ResolveError::Upstream);
            }
            chunk = tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, chunks.next()) => {
                chunk.map_err(|_| ResolveError::Upstream)?
            }
        };
        let Some(chunk) = chunk else {
            return Ok(());
        };
        tokio::time::timeout(
            UPSTREAM_BODY_TIMEOUT,
            fill.push(chunk.map_err(|_| ResolveError::Upstream)?),
        )
        .await
        .map_err(|_| ResolveError::Upstream)??;
    }
}

pub(super) async fn run_segment_fill(
    mut fill: SegmentFill,
    initial_chunks: Vec<Bytes>,
    response: reqwest::Response,
    started_at: Instant,
    slot: Arc<StreamFill>,
    mut fill_guard: tokio::sync::OwnedMutexGuard<Option<StreamFillState>>,
    _permit: adaptive_capacity::AdaptivePermit,
) {
    let chunks = futures_util::stream::iter(initial_chunks.into_iter().map(Ok))
        .chain(response.bytes_stream());
    let read_result = fill_from_stream(&mut fill, chunks).await;
    let complete = read_result.is_ok()
        && fill
            .expected_len
            .is_none_or(|expected| expected == fill.bytes);

    let result = match read_result {
        Ok(()) => fill.finish().await,
        Err(error) => Err(error),
    };
    if let Some(live) = fill.live.as_ref() {
        live.progress
            .send_modify(|progress| progress.end = Some(result.is_ok()));
    }
    slot.live
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .take();
    STREAM_METRICS
        .segment_upstream_downloads
        .fetch_add(1, Ordering::Relaxed);
    STREAM_METRICS.segment_upstream_download_ms.fetch_add(
        started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        Ordering::Relaxed,
    );
    STREAM_METRICS
        .segment_upstream_bytes
        .fetch_add(fill.bytes as u64, Ordering::Relaxed);
    if fill.downstream_cancelled {
        *fill_guard = None;
        return;
    }
    *fill_guard = if result.is_ok() {
        Some(StreamFillState::Complete)
    } else if fill.detached {
        None
    } else if !complete {
        Some(StreamFillState::Interrupted)
    } else {
        Some(StreamFillState::Failed)
    };
    if let Err(error) = &result {
        tracing::warn!(
            ?error,
            bytes = fill.bytes,
            expected_bytes = fill.expected_len,
            limit_bytes = fill.max_entry_size,
            prefetch = fill.detached,
            "anime media transfer failed... /ᐠ - ˕ -マ"
        );
        STREAM_METRICS
            .segment_failed_fills
            .fetch_add(1, Ordering::Relaxed);
        if fill.bytes > 0 {
            STREAM_METRICS
                .segment_partial_fills
                .fetch_add(1, Ordering::Relaxed);
        }
        fill.fail_downstream().await;
    }
}

pub(super) fn segment_cache_key(
    provider: StreamProvider,
    upstream_url: &str,
    inspect_media_prefix: bool,
) -> String {
    format!(
        "anikoto:v2:{}:{}:{upstream_url}",
        provider.id(),
        if inspect_media_prefix {
            "stripped"
        } else {
            "raw"
        }
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum FillMode {
    Request,
    Prefetch,
}

pub(super) async fn get_cached_upstream_resource(
    state: &AppState,
    upstream_url: &str,
    provider: StreamProvider,
    inspect_media_prefix: bool,
    accept: &'static str,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let cache_key = segment_cache_key(provider, upstream_url, inspect_media_prefix);
    let max_entry_size = state.stream_max_entry_size;
    let mut coalesced = false;

    if crate::cache::request_bypasses_cache(request_headers) {
        return range::uncached_resource(
            state,
            upstream_url,
            provider,
            inspect_media_prefix,
            accept,
            method,
            request_headers,
        )
        .await;
    }

    loop {
        if let Some(cached) = state
            .stream_cache
            .get(&cache_key)
            .await
            .filter(|entry| crate::cache::stream_cache_fresh(&entry.headers))
        {
            STREAM_METRICS
                .segment_memory_hits
                .fetch_add(1, Ordering::Relaxed);
            crate::cache::touch_cache_file(crate::cache::get_stream_cache_path(&cache_key));
            return Ok(cached_response(
                cached,
                method,
                request_headers,
                if coalesced {
                    CacheStatus::Coalesced
                } else {
                    CacheStatus::Memory
                },
            ));
        }
        if let Some(cached) =
            load_stream_from_disk(&cache_key, max_entry_size, state.disk_cache_max_age_secs).await
        {
            STREAM_METRICS
                .segment_disk_hits
                .fetch_add(1, Ordering::Relaxed);
            return disk_cached_response(
                cached,
                method,
                request_headers,
                if coalesced {
                    CacheStatus::Coalesced
                } else {
                    CacheStatus::Disk
                },
            )
            .await;
        }

        if request_headers.contains_key(RANGE) || method == Method::HEAD {
            return range::uncached_resource(
                state,
                upstream_url,
                provider,
                inspect_media_prefix,
                accept,
                method,
                request_headers,
            )
            .await;
        }

        let slot = state
            .stream_fills
            .get_with(cache_key.clone(), async { Arc::default() })
            .await;
        let mut fill_guard = match slot.state.clone().try_lock_owned() {
            Ok(fill_guard) => fill_guard,
            Err(_) => {
                STREAM_METRICS
                    .segment_coalesced
                    .fetch_add(1, Ordering::Relaxed);
                let fill_guard = loop {
                    let ready = slot.ready.notified();
                    tokio::pin!(ready);
                    ready.as_mut().enable();
                    if let Some(response) = join_live_segment(&slot) {
                        STREAM_METRICS
                            .segment_live_joins
                            .fetch_add(1, Ordering::Relaxed);
                        return Ok(response);
                    }
                    tokio::select! {
                        fill_guard = slot.state.lock() => break fill_guard,
                        _ = ready => {}
                    }
                };
                let failed = matches!(
                    *fill_guard,
                    Some(StreamFillState::Failed | StreamFillState::Interrupted)
                );
                drop(fill_guard);
                if failed {
                    return Err(ResolveError::Upstream);
                }
                coalesced = true;
                continue;
            }
        };

        if *fill_guard == Some(StreamFillState::Interrupted) {
            *fill_guard = None;
            return Err(ResolveError::Upstream);
        }

        if let Some(cached) = state
            .stream_cache
            .get(&cache_key)
            .await
            .filter(|entry| crate::cache::stream_cache_fresh(&entry.headers))
        {
            drop(fill_guard);
            STREAM_METRICS
                .segment_memory_hits
                .fetch_add(1, Ordering::Relaxed);
            crate::cache::touch_cache_file(crate::cache::get_stream_cache_path(&cache_key));
            return Ok(cached_response(
                cached,
                method,
                request_headers,
                CacheStatus::Memory,
            ));
        }
        if let Some(cached) =
            load_stream_from_disk(&cache_key, max_entry_size, state.disk_cache_max_age_secs).await
        {
            drop(fill_guard);
            STREAM_METRICS
                .segment_disk_hits
                .fetch_add(1, Ordering::Relaxed);
            return disk_cached_response(cached, method, request_headers, CacheStatus::Disk).await;
        }

        *fill_guard = None;
        STREAM_METRICS
            .segment_cache_misses
            .fetch_add(1, Ordering::Relaxed);
        let permit = match state
            .stream_upstream_permit
            .acquire_timeout(Duration::from_secs(10))
            .await
        {
            Some(permit) => permit,
            None => {
                STREAM_METRICS
                    .segment_failed_fills
                    .fetch_add(1, Ordering::Relaxed);
                *fill_guard = Some(StreamFillState::Failed);
                return Err(ResolveError::Busy);
            }
        };
        return start_segment_fill(
            state,
            slot,
            fill_guard,
            permit,
            cache_key,
            upstream_url,
            provider,
            inspect_media_prefix,
            accept,
            FillMode::Request,
        )
        .await?
        .ok_or(ResolveError::Upstream);
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn start_segment_fill(
    state: &AppState,
    slot: Arc<StreamFill>,
    mut fill_guard: tokio::sync::OwnedMutexGuard<Option<StreamFillState>>,
    permit: adaptive_capacity::AdaptivePermit,
    cache_key: String,
    upstream_url: &str,
    provider: StreamProvider,
    inspect_media_prefix: bool,
    accept: &'static str,
    mode: FillMode,
) -> Result<Option<Response>, ResolveError> {
    let failed = match mode {
        FillMode::Request => Some(StreamFillState::Failed),
        FillMode::Prefetch => None,
    };
    let max_entry_size = state.stream_max_entry_size;
    let mut fill_attempt = SegmentFillAttempt::start();
    let started_at = Instant::now();
    let mut response = match send_with_retry(|| {
        state
            .asset_client
            .get(upstream_url)
            .header(ACCEPT, accept)
            .headers(provider.headers())
    })
    .await
    {
        Ok(response) => response,
        Err(error) => {
            *fill_guard = failed;
            return Err(error);
        }
    };
    if response.status() != StatusCode::OK || response.headers().contains_key(CONTENT_RANGE) {
        *fill_guard = failed;
        if mode == FillMode::Prefetch {
            return Ok(None);
        }
        let status = response.status();
        let headers = crate::proxy::build_safe_response_headers(response.headers(), true);
        return Ok(Some(range::stream_response(
            response, permit, status, headers, 0, None,
        )));
    }

    let received_at = std::time::SystemTime::now();
    let ttl =
        crate::cache::freshness_lifetime(response.headers(), true, state.disk_cache_max_age_secs)
            .zip(crate::cache::response_age(
                response.headers(),
                received_at,
                started_at.elapsed(),
            ))
            .map(|(lifetime, age)| Duration::from_secs(lifetime).saturating_sub(age).as_secs())
            .unwrap_or(0);
    let cacheable = ttl > 0 && crate::proxy::response_allows_shared_cache(response.headers());
    if mode == FillMode::Prefetch && !cacheable {
        fill_attempt.hand_off();
        return Ok(None);
    }

    let raw_len = response.content_length();
    let max_prefix_len = if inspect_media_prefix {
        SEGMENT_PREFIX_BYTES
    } else {
        0
    };
    if raw_len.is_some_and(|length| length > max_entry_size.saturating_add(max_prefix_len) as u64) {
        *fill_guard = failed;
        return Err(ResolveError::TooLarge);
    }
    let content_type = response.headers().get(CONTENT_TYPE).cloned();
    let detection_bytes = SEGMENT_PREFIX_BYTES + 189;
    let mut initial = BytesMut::with_capacity(detection_bytes);
    let mut ttfb_recorded = false;
    loop {
        let next = match tokio::time::timeout(UPSTREAM_BODY_TIMEOUT, response.chunk()).await {
            Ok(Ok(next)) => next,
            _ => {
                *fill_guard = failed;
                return Err(ResolveError::Upstream);
            }
        };
        let Some(chunk) = next else {
            break;
        };
        if !ttfb_recorded && !chunk.is_empty() {
            ttfb_recorded = true;
            STREAM_METRICS.segment_upstream_ttfb_ms.fetch_add(
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
            STREAM_METRICS
                .segment_upstream_ttfb_samples
                .fetch_add(1, Ordering::Relaxed);
        }
        if initial.len().saturating_add(chunk.len()) > max_entry_size.saturating_add(max_prefix_len)
        {
            *fill_guard = failed;
            return Err(ResolveError::TooLarge);
        }
        initial.extend_from_slice(&chunk);
        if !inspect_media_prefix || initial.len() >= detection_bytes {
            break;
        }
    }
    if initial.is_empty() {
        *fill_guard = failed;
        return Err(ResolveError::Upstream);
    }
    let prefix_len = if inspect_media_prefix {
        media_prefix_len(&initial)
    } else {
        0
    };
    if raw_len.is_some_and(|length| length <= prefix_len as u64) {
        *fill_guard = failed;
        return Err(ResolveError::Upstream);
    }
    let expected_len = raw_len.map(|length| length as usize - prefix_len);
    let first_output = initial.freeze().slice(prefix_len..);
    let initial_chunks = vec![first_output.clone()];

    let mut cache_headers = HeaderMap::new();
    cache_headers.insert(
        CONTENT_TYPE,
        normalized_content_type(&first_output, content_type),
    );
    if let Some(length) = expected_len {
        cache_headers.insert(
            CONTENT_LENGTH,
            HeaderValue::from_str(&length.to_string()).map_err(|_| ResolveError::Upstream)?,
        );
    }
    cache_headers.insert(
        "date",
        HeaderValue::from_str(&httpdate::fmt_http_date(received_at))
            .map_err(|_| ResolveError::Upstream)?,
    );
    cache_headers.insert(
        "cache-control",
        if cacheable {
            HeaderValue::from_str(&format!(
                "public, max-age={ttl}, must-revalidate, no-transform"
            ))
            .map_err(|_| ResolveError::Upstream)?
        } else {
            HeaderValue::from_static("no-store")
        },
    );

    let (disk, disk_failed) = if !cacheable {
        (None, false)
    } else {
        match StreamCacheWriter::create(&cache_key, StatusCode::OK.as_u16(), &cache_headers).await {
            Ok(writer) => (Some(writer), false),
            Err(_) => (None, true),
        }
    };
    let ram_limit = state.ram_cache_limit.min(max_entry_size);
    let ram_capacity = expected_len.unwrap_or_default().min(ram_limit);
    let ram_cacheable =
        cacheable && ram_limit > 0 && expected_len.is_none_or(|length| length <= ram_limit);
    let live = expected_len
        .filter(|_| ram_cacheable)
        .map(|len| Arc::new(LiveSegment::new(cache_headers.clone(), len)));
    let ram = (ram_cacheable && live.is_none()).then(|| BytesMut::with_capacity(ram_capacity));
    let (sender, body) = match (mode, &live) {
        (FillMode::Prefetch, _) => (None, None),
        (FillMode::Request, Some(live)) => (None, Some(live.body(live.progress.subscribe()))),
        (FillMode::Request, None) => {
            let (sender, receiver) = mpsc::channel(state.channel_buffer.max(1));
            (
                Some(sender),
                Some(Body::from_stream(ReceiverStream::new(receiver))),
            )
        }
    };
    if live.is_some() {
        *slot
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = live.clone();
        slot.ready.notify_waiters();
    }
    let fill = SegmentFill {
        cacheable,
        cache_key,
        cache: state.stream_cache.clone(),
        headers: cache_headers.clone(),
        expected_len,
        max_entry_size,
        ram_limit,
        ram,
        live,
        detached: mode == FillMode::Prefetch,
        disk,
        disk_failed,
        sender,
        downstream_cancelled: false,
        bytes: 0,
    };
    fill_attempt.hand_off();
    tokio::spawn(run_segment_fill(
        fill,
        initial_chunks,
        response,
        started_at,
        slot,
        fill_guard,
        permit,
    ));

    Ok(body.map(|body| {
        cache_headers.insert("X-Cache", CacheStatus::Miss.header());
        cache_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        let mut downstream = Response::new(body);
        *downstream.status_mut() = StatusCode::OK;
        *downstream.headers_mut() = cache_headers;
        downstream
    }))
}
