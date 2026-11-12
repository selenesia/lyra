use super::*;

pub(super) fn provider_cache_key(
    provider: StreamProvider,
    key: &EpisodeKey,
) -> (StreamProvider, EpisodeKey) {
    let mut episode = key.clone();
    episode.session.clear();
    episode.prefer_4k = false;
    episode.auto_4k = false;
    episode.provider = None;
    (provider, episode)
}

pub(super) async fn first_ready<T>(
    candidates: impl IntoIterator<Item = impl std::future::Future<Output = Result<T, ResolveError>>>,
) -> Result<T, ResolveError> {
    let mut pending = candidates
        .into_iter()
        .collect::<futures_util::stream::FuturesUnordered<_>>();
    let mut failure = ResolveError::NotFound;
    while let Some(result) = pending.next().await {
        match result {
            Ok(source) => return Ok(source),
            Err(error) if !matches!(error, ResolveError::NotFound) => failure = error,
            Err(_) => {}
        }
    }
    Err(failure)
}

pub(super) fn has_4k(source: &ResolvedSource) -> bool {
    parse_hls_qualities(&source.master)
        .iter()
        .any(|quality| quality.2 >= 2160)
}

pub(super) async fn prefer_ready<T>(
    preferred: impl std::future::Future<Output = Result<T, ResolveError>>,
    fallback: impl std::future::Future<Output = Result<T, ResolveError>>,
    fallback_grace: Option<Duration>,
) -> Result<T, ResolveError> {
    tokio::pin!(preferred, fallback);
    tokio::select! {
        result = &mut preferred => match result {
            Ok(source) => Ok(source),
            Err(_) => fallback.await,
        },
        backup = &mut fallback => match backup {
            Err(error) => preferred.await.or(Err(error)),
            Ok(source) => match fallback_grace {
                Some(grace) => tokio::time::timeout(grace, preferred)
                    .await
                    .unwrap_or(Err(ResolveError::NotFound))
                    .or(Ok(source)),
                None => preferred.await.or(Ok(source)),
            },
        },
    }
}

pub(super) async fn default_source(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    let preferred = if key.title.is_some() {
        StreamProvider::Movy
    } else {
        StreamProvider::Framex
    };
    ordered_source(client, key, preferred).await
}

pub(super) async fn first_ready_in_order<T>(
    candidates: impl IntoIterator<Item = impl std::future::Future<Output = Result<T, ResolveError>>>,
) -> Result<T, ResolveError> {
    let mut pending = candidates
        .into_iter()
        .collect::<futures_util::stream::FuturesOrdered<_>>();
    let mut failure = ResolveError::NotFound;
    while let Some(result) = pending.next().await {
        match result {
            Ok(source) => return Ok(source),
            Err(error) if !matches!(error, ResolveError::NotFound) => failure = error,
            Err(_) => {}
        }
    }
    Err(failure)
}

pub(super) const PROVIDER_COOLDOWN: Duration = Duration::from_secs(30);

#[derive(Default)]
pub(super) struct ProviderHealth {
    pub(super) failures: u32,
    pub(super) open_until: Option<Instant>,
    pub(super) probing: bool,
    pub(super) successes: u64,
    pub(super) missing: u64,
    pub(super) errors: u64,
    pub(super) skipped: u64,
    pub(super) elapsed_ms: u64,
}

impl ProviderHealth {
    pub(super) fn admit(&mut self, now: Instant) -> bool {
        if self.probing || self.open_until.is_some_and(|until| now < until) {
            self.skipped += 1;
            return false;
        }
        self.probing = self.open_until.is_some();
        true
    }

    pub(super) fn record(
        &mut self,
        result: Result<(), ResolveError>,
        elapsed: Duration,
        now: Instant,
    ) {
        self.elapsed_ms = self.elapsed_ms.saturating_add(elapsed.as_millis() as u64);
        self.probing = false;
        match result {
            Ok(()) | Err(ResolveError::NotFound) => {
                if result.is_ok() {
                    self.successes += 1;
                } else {
                    self.missing += 1;
                }
                self.failures = 0;
                self.open_until = None;
            }
            Err(ResolveError::Upstream) => {
                self.errors += 1;
                self.failures = self.failures.saturating_add(1);
                if self.failures >= 3 {
                    self.open_until = Some(now + PROVIDER_COOLDOWN);
                }
            }
            Err(_) => {}
        }
    }
}

pub(super) static PROVIDER_HEALTH: LazyLock<
    std::sync::Mutex<std::collections::HashMap<StreamProvider, ProviderHealth>>,
> = LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub(super) struct ProviderAttempt(StreamProvider);

impl Drop for ProviderAttempt {
    fn drop(&mut self) {
        if let Some(health) = PROVIDER_HEALTH
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(&self.0)
        {
            health.probing = false;
        }
    }
}

pub(super) async fn guarded_source(
    client: &reqwest::Client,
    provider: StreamProvider,
    key: &EpisodeKey,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    let cache_key = provider_cache_key(provider, key);
    if let Some(error) = PROVIDER_FAILURES.get(&cache_key).await {
        return Err(error);
    }
    let cached = SOURCE_CACHE.get(&cache_key).await.is_some();
    if !cached
        && !PROVIDER_HEALTH
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(provider)
            .or_default()
            .admit(Instant::now())
    {
        return Err(ResolveError::Upstream);
    }
    let _attempt = (!cached).then_some(ProviderAttempt(provider));
    let budget = match provider {
        StreamProvider::Title => titles::RESOLUTION_BUDGET,
        StreamProvider::Movy => movy::resolution_budget(key),
        StreamProvider::Framex | StreamProvider::Framex4k(_) => Duration::from_secs(10),
        _ => Duration::from_secs(5),
    };
    let started = Instant::now();
    let result = tokio::time::timeout(budget, ready_source(client, provider, key))
        .await
        .unwrap_or(Err(ResolveError::Upstream));
    if !cached {
        PROVIDER_HEALTH
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .entry(provider)
            .or_default()
            .record(
                result.as_ref().map(|_| ()).map_err(|error| *error),
                started.elapsed(),
                Instant::now(),
            );
    }
    if let Err(error) = result {
        PROVIDER_FAILURES.insert(cache_key, error).await;
    }
    result
}

pub(super) async fn ordered_source(
    client: &reqwest::Client,
    key: &EpisodeKey,
    start: StreamProvider,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    let mut providers = StreamProvider::ALL;
    if let Some(index) = providers.iter().position(|provider| *provider == start) {
        providers.rotate_left(index);
    }
    first_ready_in_order(
        providers
            .into_iter()
            .filter(|provider| provider.supports(key))
            .map(|provider| Box::pin(guarded_source(client, provider, key))),
    )
    .await
}

pub(super) async fn select_source(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    if let Some(provider) = key.provider {
        return guarded_source(client, provider, key).await;
    }
    if key.title.is_some() || (!key.prefer_4k && !key.auto_4k) {
        return default_source(client, key).await;
    }
    let mut normal_key = key.clone();
    normal_key.prefer_4k = false;
    normal_key.auto_4k = false;
    let current = SESSION_SOURCES
        .get(&normal_key)
        .await
        .filter(|session| !session.invalidated.load(Ordering::Acquire));
    if let Some(session) = &current {
        if has_4k(&session.source) {
            return Ok(session.source.clone());
        }
    }
    let current_provider = current.as_ref().map(|session| session.source.provider);
    let discovery = tokio::spawn({
        let client = client.clone();
        let key = key.clone();
        async move { discover_4k(&client, &key, current_provider).await }
    });
    let preferred = async {
        discovery
            .await
            .map_err(|_| ResolveError::Upstream)??
            .ok_or(ResolveError::NotFound)
    };
    let fallback = async {
        match &current {
            Some(session) => Ok(session.source.clone()),
            None => default_source(client, key).await,
        }
    };
    let grace = (!key.prefer_4k).then_some(AUTO_4K_GRACE);
    prefer_ready(preferred, fallback, grace).await
}

pub(super) fn quality_providers(key: &EpisodeKey) -> impl Iterator<Item = StreamProvider> + '_ {
    StreamProvider::ALL
        .into_iter()
        .chain(framex::MovieServer::ALL.map(StreamProvider::Framex4k))
        .filter(|provider| provider.supports(key))
}

pub(super) async fn discover_4k(
    client: &reqwest::Client,
    key: &EpisodeKey,
    current: Option<StreamProvider>,
) -> Result<Option<Arc<ResolvedSource>>, ResolveError> {
    let cache_key = provider_cache_key(StreamProvider::Megaplay, key).1;
    if let Some(Some(source)) = QUALITY_DISCOVERY.get(&cache_key).await {
        if FAILED_SOURCES.get(&source.playlist_url).await.is_some() {
            QUALITY_DISCOVERY.invalidate(&cache_key).await;
        }
    }
    QUALITY_DISCOVERY
        .try_get_with(cache_key.clone(), async {
            match KNOWN_4K.get(&cache_key).await {
                Some(None) => return Ok(None),
                Some(Some(provider)) => {
                    if current != Some(provider) {
                        if let Ok(source) = guarded_source(client, provider, key).await {
                            if has_4k(&source) {
                                return Ok(Some(source));
                            }
                        }
                    }
                    KNOWN_4K.invalidate(&cache_key).await;
                }
                None => {}
            }
            let _slot = QUALITY_DISCOVERY_SLOTS
                .try_acquire()
                .map_err(|_| ResolveError::Busy)?;
            let result = tokio::time::timeout(
                Duration::from_secs(9),
                first_ready(
                    quality_providers(key)
                        .filter(|provider| current != Some(*provider))
                        .map(|provider| async move {
                            if let Some(error) = PROVIDER_FAILURES
                                .get(&provider_cache_key(provider, key))
                                .await
                            {
                                return Err(error);
                            }
                            if SOURCE_CACHE
                                .get(&provider_cache_key(provider, key))
                                .await
                                .is_some_and(|source| !has_4k(&source))
                            {
                                return Err(ResolveError::NotFound);
                            }
                            let source = guarded_source(client, provider, key).await?;
                            if has_4k(&source) {
                                Ok(source)
                            } else {
                                Err(ResolveError::NotFound)
                            }
                        }),
                ),
            )
            .await
            .unwrap_or(Err(ResolveError::Upstream));
            match &result {
                Ok(source) => {
                    KNOWN_4K
                        .insert(cache_key.clone(), Some(source.provider))
                        .await
                }
                Err(ResolveError::NotFound) => KNOWN_4K.insert(cache_key.clone(), None).await,
                Err(_) => {}
            }
            Ok::<_, ResolveError>(result.ok())
        })
        .await
        .map_err(|error| *error)
}

pub(super) async fn ready_source(
    client: &reqwest::Client,
    provider: StreamProvider,
    key: &EpisodeKey,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    let started = Instant::now();
    let mut stage = "extraction";
    let result = tokio::time::timeout(SOURCE_RESOLUTION_TIMEOUT, async {
        let cache_key = provider_cache_key(provider, key);
        if let Some(mut source) = SOURCE_CACHE.get(&cache_key).await {
            stage = "readiness";
            match validate_source(client, &source).await {
                Ok(master)
                    if !matches!(provider, StreamProvider::Framex4k(_))
                        || parse_hls_qualities(&master)
                            .iter()
                            .any(|quality| quality.2 >= 2160) =>
                {
                    if master != source.master {
                        source = Arc::new(with_master((*source).clone(), master));
                        SOURCE_CACHE.insert(cache_key.clone(), source.clone()).await;
                    }
                    return Ok(source);
                }
                _ => {
                    reject_source(key, &source, &[&source.playlist_url]).await;
                }
            }
        }
        SOURCE_CACHE
            .try_get_with(cache_key, async {
                for _ in 0..2 {
                    stage = "extraction";
                    let source = provider.resolve(client, key).await?;
                    if matches!(
                        provider,
                        StreamProvider::Framex | StreamProvider::Framex4k(_) | StreamProvider::Title | StreamProvider::Movy
                    ) && !source.master.is_empty()
                    {
                        return Ok(Arc::new(source));
                    }
                    stage = "readiness";
                    match prepare_source(client, source).await {
                        Ok(source) => return Ok(Arc::new(source)),
                        Err(ResolveError::NotFound) => return Err(ResolveError::NotFound),
                        Err(_) => {}
                    }
                }
                Err(ResolveError::Upstream)
            })
            .await
            .map_err(|error| *error)
    })
    .await
    .unwrap_or(Err(ResolveError::Upstream));
    if let Err(error) = result.as_ref() {
        tracing::warn!(
            provider = provider.id(),
            stage,
            elapsed_ms = started.elapsed().as_millis() as u64,
            anilist_id = key.anilist_id,
            mal_id = key.mal_id,
            title = ?key.title,
            episode = key.episode,
            language = key.language.as_str(),
            ?error,
            "stream provider failed... /ᐠ - ˕ -マ"
        );
    }
    result
}

pub(super) async fn prepare_source(
    client: &reqwest::Client,
    mut source: ResolvedSource,
) -> Result<ResolvedSource, ResolveError> {
    loop {
        if FAILED_SOURCES.get(&source.playlist_url).await.is_some() {
            if source.fallback_playlist_url.is_none() {
                return Err(ResolveError::NotFound);
            }
        } else {
            if let Ok(master) = validate_source(client, &source).await {
                source.fallback_playlist_url = None;
                return Ok(with_master(source, master));
            }
            FAILED_SOURCES.insert(source.playlist_url.clone(), ()).await;
            PLAYLIST_CACHE
                .invalidate(&playlist_cache_key(source.provider, &source.playlist_url))
                .await;
        }
        source.playlist_url = source
            .fallback_playlist_url
            .take()
            .ok_or(ResolveError::Upstream)?;
    }
}

pub(super) async fn validate_source(
    client: &reqwest::Client,
    source: &ResolvedSource,
) -> Result<Arc<String>, ResolveError> {
    let master = if matches!(source.provider, StreamProvider::Title | StreamProvider::Movy)
        && !source.master.is_empty()
    {
        source.master.clone()
    } else {
        fetch_playlist(client, &source.playlist_url, source.provider).await?
    };
    if is_master_playlist(&master) {
        let variants = hls_variant_references(&source.playlist_url, &master);
        let count = variants.len();
        let provider = source.provider;
        let settle_all = matches!(
            provider,
            StreamProvider::Framex4k(_) | StreamProvider::Title | StreamProvider::Movy
        );
        let mut checks =
            futures_util::stream::iter(variants.into_iter().enumerate().map(|(index, url)| {
                let client = client.clone();
                async move {
                    let valid = tokio::time::timeout(QUALITY_CHECK_TIMEOUT, async {
                        match fetch_playlist(&client, &url, provider).await {
                            Ok(media) => probe_media(&client, &url, &media, provider).await.is_ok(),
                            Err(_) => false,
                        }
                    })
                    .await
                    .unwrap_or(false);
                    (index, valid)
                }
            }))
            .buffer_unordered(4);
        let mut settled = vec![None; count];
        let mut grace_deadline = None;
        loop {
            let next = match grace_deadline {
                Some(deadline) => match tokio::time::timeout_at(deadline, checks.next()).await {
                    Ok(next) => next,
                    Err(_) => break,
                },
                None => checks.next().await,
            };
            let Some((index, valid)) = next else {
                break;
            };
            settled[index] = Some(valid);
            if valid && !settle_all && grace_deadline.is_none() {
                grace_deadline = Some(tokio::time::Instant::now() + QUALITY_SETTLE_GRACE);
            }
        }
        let available: Vec<bool> = settled
            .into_iter()
            .map(|valid| valid != Some(false))
            .collect();
        return filter_variants(&master, &available).map(Arc::new);
    }
    probe_media(client, &source.playlist_url, &master, source.provider).await?;
    Ok(master)
}

pub(super) fn with_master(mut source: ResolvedSource, master: Arc<String>) -> ResolvedSource {
    source.generation = source_generation(
        source.provider,
        &source.internal_id,
        source.language.as_deref(),
        &format!("{}\n{}", source.playlist_url, master),
        &source.tracks,
    );
    source.master = master;
    source
}

pub(super) fn filter_variants(master: &str, available: &[bool]) -> Result<String, ResolveError> {
    if !available.iter().any(|valid| *valid) {
        return Err(ResolveError::Upstream);
    }
    let mut output = String::with_capacity(master.len());
    let mut index = 0;
    let mut include = true;
    let mut awaiting_uri = false;
    for line in master.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            include = available.get(index).copied().unwrap_or(false);
            index += 1;
            awaiting_uri = true;
        }
        if include {
            output.push_str(line);
            output.push('\n');
        }
        if awaiting_uri && !trimmed.is_empty() && !trimmed.starts_with('#') {
            awaiting_uri = false;
            include = true;
        }
    }
    Ok(output)
}

pub(super) async fn probe_media(
    client: &reqwest::Client,
    base: &str,
    media: &str,
    provider: StreamProvider,
) -> Result<(), ResolveError> {
    let resources = first_media_resources(base, media)?;
    futures_util::future::try_join_all(
        resources
            .iter()
            .map(|url| probe_resource(client, url, provider)),
    )
    .await?;
    Ok(())
}

pub(super) fn first_media_resources(base: &str, media: &str) -> Result<Vec<String>, ResolveError> {
    if !is_media_playlist(media) {
        return Err(ResolveError::Upstream);
    }
    let mut resources = Vec::new();
    for line in media.lines().map(str::trim) {
        let value = if line.starts_with("#EXT-X-KEY:") || line.starts_with("#EXT-X-MAP:") {
            quoted_uri(line).map(|(_, _, uri)| uri)
        } else if !line.is_empty() && !line.starts_with('#') {
            Some(line)
        } else {
            None
        };
        if let Some(value) = value {
            resources.push(absolute_url(base, value).ok_or(ResolveError::Upstream)?);
            if !line.starts_with('#') {
                break;
            }
        }
    }
    if resources.is_empty() {
        return Err(ResolveError::Upstream);
    }
    Ok(resources)
}

pub(super) async fn probe_resource(
    client: &reqwest::Client,
    url: &str,
    provider: StreamProvider,
) -> Result<(), ResolveError> {
    RESOURCE_PROBES
        .try_get_with(playlist_cache_key(provider, url), async {
            let mut response = send_with_retry(|| {
                client
                    .get(url)
                    .headers(provider.headers())
                    .header(RANGE, "bytes=0-1023")
            })
            .await?;
            if !response.status().is_success() {
                return Err(ResolveError::Upstream);
            }
            match response.chunk().await {
                Ok(Some(bytes)) if !bytes.is_empty() => Ok(()),
                _ => Err(ResolveError::Upstream),
            }
        })
        .await
        .map_err(|error| *error)
}

pub(super) fn is_media_playlist(playlist: &str) -> bool {
    playlist
        .lines()
        .any(|line| line.trim().starts_with("#EXTINF:"))
        && playlist
            .lines()
            .any(|line| !line.trim().is_empty() && !line.trim().starts_with('#'))
        && !is_master_playlist(playlist)
}

pub(super) async fn get_source(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<Arc<ResolvedSource>, ResolveError> {
    if let Some(selected) = SESSION_SOURCES.get(key).await {
        STREAM_METRICS
            .source_cache_hits
            .fetch_add(1, Ordering::Relaxed);
        if !selected.invalidated.load(Ordering::Acquire) {
            return Ok(selected.source.clone());
        }
        let _refresh = selected.refresh.lock().await;
        let selected = SESSION_SOURCES.get(key).await.unwrap_or(selected.clone());
        if !selected.invalidated.load(Ordering::Acquire) {
            return Ok(selected.source.clone());
        }
        let source = if key.provider.is_some()
            || ((key.prefer_4k || key.auto_4k) && has_4k(&selected.source))
        {
            select_source(client, key).await?
        } else {
            ordered_source(client, key, selected.source.provider).await?
        };
        SESSION_SOURCES
            .insert(
                key.clone(),
                Arc::new(SourceSession {
                    source: source.clone(),
                    invalidated: AtomicBool::new(false),
                    refresh: selected.refresh.clone(),
                }),
            )
            .await;
        return Ok(source);
    }
    STREAM_METRICS
        .source_cache_misses
        .fetch_add(1, Ordering::Relaxed);
    tokio::time::timeout(
        SOURCE_RESOLUTION_TIMEOUT,
        SESSION_SOURCES.try_get_with(key.clone(), async move {
            let started_at = Instant::now();
            let result = select_source(client, key).await;
            if let Ok(source) = result.as_ref() {
                tracing::info!(
                    provider = source.provider.id(),
                    anilist_id = key.anilist_id,
                    mal_id = key.mal_id,
                    title = ?key.title,
                    episode = key.episode,
                    language = key.language.as_str(),
                    confirmed_language = source.language.as_deref(),
                    elapsed_ms = started_at.elapsed().as_millis() as u64,
                    "stream selected!! (˵◝ ⩊  ◜˵マ"
                );
            }
            STREAM_METRICS
                .source_resolutions
                .fetch_add(1, Ordering::Relaxed);
            STREAM_METRICS.source_resolution_ms.fetch_add(
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
            result.map(SourceSession::new)
        }),
    )
    .await
    .map_err(|_| ResolveError::Upstream)?
    .map(|selected| selected.source.clone())
    .map_err(|error| *error)
}
