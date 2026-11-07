use super::*;

pub(super) fn prefetch_resources(
    state: &Arc<AppState>,
    provider: StreamProvider,
    resources: &[String],
    index: usize,
    method: &Method,
    request_headers: &HeaderMap,
) {
    if state.stream_prefetch_segments == 0
        || method != Method::GET
        || request_headers.contains_key(RANGE)
        || crate::cache::request_bypasses_cache(request_headers)
        || state.memory_pressure.shedding()
    {
        return;
    }
    for upstream_url in resources
        .iter()
        .skip(index + 1)
        .take(state.stream_prefetch_segments)
    {
        let state = state.clone();
        let upstream_url = upstream_url.clone();
        tokio::spawn(async move { prefetch_resource(&state, provider, &upstream_url).await });
    }
}

pub(super) fn warm_source(state: &Arc<AppState>, source: &Arc<ResolvedSource>) {
    if state.stream_prefetch_segments == 0 || state.memory_pressure.shedding() {
        return;
    }
    let state = state.clone();
    let source = source.clone();
    tokio::spawn(async move {
        if !WARMED_SOURCES
            .entry(source.generation)
            .or_insert(())
            .await
            .is_fresh()
        {
            return;
        }
        let resources = startup_resources(&state.asset_client, &source).await;
        futures_util::future::join_all(
            resources
                .iter()
                .map(|url| prefetch_resource(&state, source.provider, url)),
        )
        .await;
    });
}

pub(super) async fn startup_resources(
    client: &reqwest::Client,
    source: &ResolvedSource,
) -> Vec<String> {
    let playlists: Vec<String> = if is_master_playlist(&source.master) {
        hls_variant_references(&source.playlist_url, &source.master)
            .into_iter()
            .take(1)
            .chain(source.language.as_deref().and_then(|language| {
                framex::audio_url(&source.master, &source.playlist_url, language)
            }))
            .collect()
    } else {
        vec![source.playlist_url.clone()]
    };
    futures_util::future::join_all(playlists.iter().map(|url| async {
        let playlist = fetch_playlist(client, url, source.provider).await.ok()?;
        first_media_resources(url, &playlist).ok()
    }))
    .await
    .into_iter()
    .flatten()
    .flatten()
    .collect()
}

pub(super) async fn prefetch_resource(
    state: &AppState,
    provider: StreamProvider,
    upstream_url: &str,
) {
    let cache_key = segment_cache_key(provider, upstream_url, true);
    let cached = || async {
        state
            .stream_cache
            .get(&cache_key)
            .await
            .is_some_and(|entry| crate::cache::stream_cache_fresh(&entry.headers))
    };
    if cached().await {
        return;
    }
    let slot = state
        .stream_fills
        .get_with(cache_key.clone(), async { Arc::default() })
        .await;
    let Ok(mut fill_guard) = slot.state.clone().try_lock_owned() else {
        return;
    };
    if *fill_guard == Some(StreamFillState::Interrupted)
        || cached().await
        || load_stream_from_disk(
            &cache_key,
            state.stream_max_entry_size,
            state.disk_cache_max_age_secs,
        )
        .await
        .is_some()
    {
        return;
    }
    let capacity = state.stream_upstream_permit.snapshot();
    if capacity.active.saturating_mul(2) >= capacity.limit {
        return;
    }
    let Some(permit) = state.stream_upstream_permit.try_acquire() else {
        return;
    };
    *fill_guard = None;
    STREAM_METRICS
        .segment_prefetches
        .fetch_add(1, Ordering::Relaxed);
    let _ = start_segment_fill(
        state,
        slot,
        fill_guard,
        permit,
        cache_key,
        upstream_url,
        provider,
        true,
        MEDIA_ACCEPT,
        FillMode::Prefetch,
    )
    .await;
}

pub(super) async fn playlist_resource(
    state: &Arc<AppState>,
    source: &ResolvedSource,
    playlist_url: &str,
    playlist: &Arc<String>,
    resource: usize,
    method: &Method,
    request_headers: &HeaderMap,
) -> Result<Response, ResolveError> {
    let resources = playlist_references(playlist_url, playlist).await;
    let upstream_url = resources.get(resource).ok_or(ResolveError::Invalid)?;
    let response = get_cached_upstream_resource(
        state,
        upstream_url,
        source.provider,
        true,
        MEDIA_ACCEPT,
        method,
        request_headers,
    )
    .await?;
    if response.status().is_success() {
        prefetch_resources(
            state,
            source.provider,
            &resources,
            resource,
            method,
            request_headers,
        );
    }
    Ok(response)
}
