use super::*;

pub(super) fn playlist_cache_key(provider: StreamProvider, url: &str) -> String {
    format!("{}:{url}", provider.id())
}

pub(super) async fn fetch_playlist(
    client: &reqwest::Client,
    url: &str,
    provider: StreamProvider,
) -> Result<Arc<String>, ResolveError> {
    let cache_key = playlist_cache_key(provider, url);
    if let Some(playlist) = PLAYLIST_CACHE.get(&cache_key).await {
        STREAM_METRICS
            .playlist_cache_hits
            .fetch_add(1, Ordering::Relaxed);
        return Ok(playlist);
    }
    STREAM_METRICS
        .playlist_cache_misses
        .fetch_add(1, Ordering::Relaxed);
    let owned_client = client.clone();
    let owned_url = url.to_string();
    PLAYLIST_CACHE
        .try_get_with(cache_key, async move {
            let started_at = Instant::now();
            let result = async {
                let parsed = Url::parse(&owned_url).map_err(|_| ResolveError::Upstream)?;
                if parsed.scheme() != "https" {
                    return Err(ResolveError::Upstream);
                }
                let response = send_with_retry(|| {
                    owned_client
                        .get(parsed.clone())
                        .header(
                            ACCEPT,
                            "application/vnd.apple.mpegurl,application/x-mpegURL,text/plain",
                        )
                        .headers(provider.headers())
                })
                .await?;
                if !response.status().is_success() {
                    return Err(ResolveError::Upstream);
                }
                let final_url = response.url().clone();
                if final_url.scheme() != "https" {
                    return Err(ResolveError::Upstream);
                }
                let text = String::from_utf8(
                    read_body_limited(response, MAX_METADATA_BYTES)
                        .await?
                        .to_vec(),
                )
                .map_err(|_| ResolveError::Upstream)?;
                if !text.trim_start().starts_with("#EXTM3U") {
                    return Err(ResolveError::Upstream);
                }

                Ok(Arc::new(if final_url != parsed {
                    rebase_playlist(final_url.as_str(), &text)?
                } else {
                    text
                }))
            }
            .await;
            STREAM_METRICS
                .playlist_resolutions
                .fetch_add(1, Ordering::Relaxed);
            STREAM_METRICS.playlist_resolution_ms.fetch_add(
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
            result
        })
        .await
        .map_err(|error| *error)
}

pub(super) fn absolute_url(base: &str, value: &str) -> Option<String> {
    Url::parse(base)
        .ok()?
        .join(value.trim())
        .ok()
        .and_then(|url| (url.scheme() == "https").then(|| url.to_string()))
}

pub(super) fn rebase_playlist(base_url: &str, playlist: &str) -> Result<String, ResolveError> {
    let references = hls_references(base_url, playlist);
    let mut invalid = false;
    let playlist = rewrite_hls(playlist, |index| {
        references.get(index).cloned().unwrap_or_else(|| {
            invalid = true;
            String::new()
        })
    })?;
    if invalid {
        Err(ResolveError::Upstream)
    } else {
        Ok(playlist)
    }
}

pub(super) fn quoted_uri(line: &str) -> Option<(usize, usize, &str)> {
    let marker = "URI=\"";
    let start = line.find(marker)? + marker.len();
    let end = start + line.get(start..)?.find('"')?;
    Some((start, end, line.get(start..end)?))
}

pub(super) fn hls_references(base_url: &str, playlist: &str) -> Vec<String> {
    let mut references = Vec::new();
    for line in playlist.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('#') {
            if let Some((_, _, value)) = quoted_uri(line) {
                if let Some(url) = absolute_url(base_url, value) {
                    references.push(url);
                }
            }
        } else if let Some(url) = absolute_url(base_url, line) {
            references.push(url);
        }
    }
    references
}

pub(super) async fn playlist_references(
    playlist_url: &str,
    playlist: &Arc<String>,
) -> Arc<Vec<String>> {
    if let Some((cached, references)) = PLAYLIST_REFERENCES.get(playlist_url).await {
        if Arc::ptr_eq(&cached, playlist) {
            return references;
        }
    }
    let references = Arc::new(hls_references(playlist_url, playlist));
    PLAYLIST_REFERENCES
        .insert(
            playlist_url.to_string(),
            (playlist.clone(), references.clone()),
        )
        .await;
    references
}

pub(super) fn hls_variant_references(base_url: &str, playlist: &str) -> Vec<String> {
    let lines: Vec<_> = playlist.lines().map(str::trim).collect();
    let mut references = Vec::new();
    let mut expecting_variant = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if line.starts_with("#EXT-X-STREAM-INF:") {
            expecting_variant = true;
            continue;
        }
        if expecting_variant {
            if !line.starts_with('#') {
                if let Some(url) = absolute_url(base_url, line) {
                    references.push(url);
                }
            }
            expecting_variant = false;
        }
    }
    references
}

pub(super) fn hls_master_references(base_url: &str, playlist: &str) -> Vec<String> {
    playlist
        .lines()
        .map(str::trim)
        .filter(|line| {
            line.starts_with("#EXT-X-MEDIA:") || line.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
        })
        .filter_map(quoted_uri)
        .filter_map(|(_, _, value)| absolute_url(base_url, value))
        .collect()
}

pub(super) fn hls_attribute_list(value: &str) -> Vec<(&str, &str)> {
    let mut attributes = Vec::new();
    let mut start = 0;
    let mut quoted = false;
    for (index, character) in value.char_indices() {
        match character {
            '"' => quoted = !quoted,
            ',' if !quoted => {
                if let Some(attribute) = value.get(start..index) {
                    if let Some((key, value)) = attribute.split_once('=') {
                        attributes.push((key.trim(), value.trim().trim_matches('"')));
                    }
                }
                start = index + character.len_utf8();
            }
            _ => {}
        }
    }
    if let Some(attribute) = value.get(start..) {
        if let Some((key, value)) = attribute.split_once('=') {
            attributes.push((key.trim(), value.trim().trim_matches('"')));
        }
    }
    attributes
}

pub(super) fn hls_attribute<'a>(attributes: &'a [(&str, &str)], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find_map(|(key, value)| (*key == name).then_some(*value))
}

pub(super) fn parse_hls_qualities(playlist: &str) -> Vec<(usize, u32, u32, u64, String)> {
    let mut qualities = Vec::new();
    for line in playlist.lines().map(str::trim) {
        let Some(attributes) = line.strip_prefix("#EXT-X-STREAM-INF:") else {
            continue;
        };
        let attributes = hls_attribute_list(attributes);
        let (width, height) = hls_attribute(&attributes, "RESOLUTION")
            .and_then(|resolution| resolution.split_once('x'))
            .map(|(width, height)| {
                (
                    width.parse::<u32>().unwrap_or(0),
                    height.parse::<u32>().unwrap_or(0),
                )
            })
            .unwrap_or((0, 0));
        let bitrate = hls_attribute(&attributes, "BANDWIDTH")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let codecs = hls_attribute(&attributes, "CODECS")
            .unwrap_or_default()
            .to_string();
        qualities.push((qualities.len(), width, height, bitrate, codecs));
    }
    qualities
}

pub(super) fn parse_hls_audio_tracks(playlist: &str) -> Vec<(String, String, bool)> {
    let mut tracks = Vec::new();
    for line in playlist.lines().map(str::trim) {
        let Some(attributes) = line.strip_prefix("#EXT-X-MEDIA:") else {
            continue;
        };
        let attributes = hls_attribute_list(attributes);
        if hls_attribute(&attributes, "TYPE") != Some("AUDIO") {
            continue;
        }
        let language = hls_attribute(&attributes, "LANGUAGE")
            .unwrap_or("und")
            .to_ascii_lowercase();
        let label = hls_attribute(&attributes, "NAME")
            .or_else(|| hls_attribute(&attributes, "LANGUAGE"))
            .unwrap_or("audio")
            .to_string();
        let default = matches!(
            hls_attribute(&attributes, "DEFAULT"),
            Some("YES" | "yes" | "TRUE" | "true" | "1")
        );
        tracks.push((label, language, default));
    }
    tracks
}

pub(super) fn rewrite_hls_master<F, G>(
    playlist: &str,
    mut variant_route: F,
    mut resource_route: G,
) -> Result<String, ResolveError>
where
    F: FnMut(usize) -> String,
    G: FnMut(usize) -> String,
{
    let mut output = String::with_capacity(playlist.len() + 256);
    let mut expecting_variant = false;
    let mut variant_index = 0usize;
    let mut resource_index = 0usize;
    let mut replaced = false;
    for line in playlist.lines() {
        let trimmed = line.trim();
        if (trimmed.starts_with("#EXT-X-MEDIA:")
            || trimmed.starts_with("#EXT-X-I-FRAME-STREAM-INF:"))
            && quoted_uri(trimmed).is_some()
        {
            if let Some((start, end, _)) = quoted_uri(trimmed) {
                output.push_str(&trimmed[..start]);
                output.push_str(&resource_route(resource_index));
                output.push_str(&trimmed[end..]);
                resource_index += 1;
            }
            expecting_variant = false;
        } else if trimmed.starts_with("#EXT-X-STREAM-INF:") {
            expecting_variant = true;
            output.push_str(trimmed);
        } else if expecting_variant && !trimmed.is_empty() && !trimmed.starts_with('#') {
            output.push_str(&variant_route(variant_index));
            variant_index += 1;
            replaced = true;
            expecting_variant = false;
        } else {
            output.push_str(trimmed);
            if expecting_variant && !trimmed.is_empty() {
                expecting_variant = false;
            }
        }
        output.push('\n');
    }
    if !replaced {
        return Err(ResolveError::Upstream);
    }
    Ok(output)
}

pub(super) fn rewrite_hls<F>(playlist: &str, mut route: F) -> Result<String, ResolveError>
where
    F: FnMut(usize) -> String,
{
    let mut output = String::with_capacity(playlist.len() + 512);
    let mut index = 0usize;
    for line in playlist.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            output.push('\n');
            continue;
        }
        if trimmed.starts_with('#') {
            if let Some((start, end, _)) = quoted_uri(trimmed) {
                output.push_str(&trimmed[..start]);
                output.push_str(&route(index));
                output.push_str(&trimmed[end..]);
                index += 1;
            } else {
                output.push_str(trimmed);
            }
        } else {
            output.push_str(&route(index));
            index += 1;
        }
        output.push('\n');
    }
    if index == 0 {
        return Err(ResolveError::Upstream);
    }
    Ok(output)
}

pub(super) fn is_master_playlist(playlist: &str) -> bool {
    playlist.lines().any(|line| {
        let line = line.trim();
        line.starts_with("#EXT-X-STREAM-INF") || line.starts_with("#EXT-X-MEDIA:")
    })
}

pub(super) async fn invalidate_source(
    key: &EpisodeKey,
    source: &ResolvedSource,
    playlist_urls: &[&str],
) {
    if source.provider == StreamProvider::Framex {
        framex::invalidate(key).await;
    } else if source.provider == StreamProvider::Title {
        titles::invalidate(key).await;
    } else if source.provider == StreamProvider::Movy {
        movy::invalidate(key).await;
    }
    let quality_key = provider_cache_key(StreamProvider::Megaplay, key).1;
    if QUALITY_DISCOVERY
        .get(&quality_key)
        .await
        .flatten()
        .is_some_and(|cached| cached.generation == source.generation)
    {
        QUALITY_DISCOVERY.invalidate(&quality_key).await;
    }
    let cache_key = provider_cache_key(source.provider, key);
    if SOURCE_CACHE
        .get(&cache_key)
        .await
        .is_some_and(|cached| cached.generation == source.generation)
    {
        SOURCE_CACHE.invalidate(&cache_key).await;
    }
    for url in playlist_urls {
        PLAYLIST_CACHE
            .invalidate(&playlist_cache_key(source.provider, url))
            .await;
    }
    if let Some(selected) = SESSION_SOURCES.get(key).await {
        if selected.source.generation == source.generation {
            selected.invalidated.store(true, Ordering::Release);
        }
    }
    STREAM_METRICS
        .source_refreshes
        .fetch_add(1, Ordering::Relaxed);
}

pub(super) async fn reject_source(
    key: &EpisodeKey,
    source: &ResolvedSource,
    playlist_urls: &[&str],
) {
    FAILED_SOURCES.insert(source.playlist_url.clone(), ()).await;
    if source.provider == StreamProvider::Movy {
        movy::reject(key, source).await;
    }
    invalidate_source(key, source, playlist_urls).await;
}

pub(super) async fn source_master(
    state: &AppState,
    key: &EpisodeKey,
) -> Result<(Arc<ResolvedSource>, Arc<String>), ResolveError> {
    let source = get_source(&state.asset_client, key).await?;
    Ok((source.clone(), source.master.clone()))
}

pub(super) async fn media_playlist(
    state: &AppState,
    key: &EpisodeKey,
    variant: i32,
    requested_generation: Option<u64>,
) -> Result<(Arc<ResolvedSource>, String, Arc<String>), ResolveError> {
    let (source, master) = source_master(state, key).await?;
    ensure_source_generation(&source, requested_generation)?;
    if !is_master_playlist(&master) {
        if variant == -1 || variant == 0 {
            return Ok((source.clone(), source.playlist_url.clone(), master));
        }
        return Err(ResolveError::Invalid);
    }
    if variant < 0 {
        return Err(ResolveError::Invalid);
    }
    let variants = hls_variant_references(&source.playlist_url, &master);
    let url = variants
        .get(variant as usize)
        .ok_or(ResolveError::Invalid)?
        .clone();
    match fetch_playlist(&state.asset_client, &url, source.provider).await {
        Ok(playlist) => Ok((source.clone(), url, playlist)),
        Err(ResolveError::Upstream | ResolveError::NotFound) => {
            reject_source(key, &source, &[&source.playlist_url, &url]).await;
            let (source, master) = source_master(state, key).await?;
            ensure_source_generation(&source, requested_generation)?;
            let variants = hls_variant_references(&source.playlist_url, &master);
            let url = variants
                .get(variant as usize)
                .ok_or(ResolveError::Invalid)?
                .clone();
            let playlist = fetch_playlist(&state.asset_client, &url, source.provider).await?;
            Ok((source, url, playlist))
        }
        Err(error) => Err(error),
    }
}

pub(super) async fn master_resource_playlist(
    state: &AppState,
    key: &EpisodeKey,
    resource: usize,
    requested_generation: Option<u64>,
) -> Result<(Arc<ResolvedSource>, String, Arc<String>), ResolveError> {
    let (source, master) = source_master(state, key).await?;
    ensure_source_generation(&source, requested_generation)?;
    let resources = hls_master_references(&source.playlist_url, &master);
    let url = resources
        .get(resource)
        .ok_or(ResolveError::Invalid)?
        .clone();
    match fetch_playlist(&state.asset_client, &url, source.provider).await {
        Ok(playlist) => Ok((source, url, playlist)),
        Err(ResolveError::Upstream | ResolveError::NotFound) => {
            reject_source(key, &source, &[&source.playlist_url, &url]).await;
            let (source, master) = source_master(state, key).await?;
            ensure_source_generation(&source, requested_generation)?;
            let resources = hls_master_references(&source.playlist_url, &master);
            let url = resources
                .get(resource)
                .ok_or(ResolveError::Invalid)?
                .clone();
            let playlist = fetch_playlist(&state.asset_client, &url, source.provider).await?;
            Ok((source, url, playlist))
        }
        Err(error) => Err(error),
    }
}

pub(super) fn playlist_response(body: String) -> Response {
    let mut response = body.into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.apple.mpegurl"),
    );
    response.headers_mut().insert(
        "Cache-Control",
        HeaderValue::from_static("private, no-cache, no-transform"),
    );
    response
}

pub(super) fn error_response(error: ResolveError) -> Response {
    let (status, message) = match error {
        ResolveError::Invalid => (
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid episode stream request",
        ),
        ResolveError::Stale => (StatusCode::CONFLICT, "stale episode stream resource"),
        ResolveError::NotFound => (
            StatusCode::NOT_FOUND,
            "this episode is unavailable from all providers",
        ),
        ResolveError::Upstream => (
            StatusCode::BAD_GATEWAY,
            "unable to load this episode; please try again",
        ),
        ResolveError::RateLimited => (
            StatusCode::SERVICE_UNAVAILABLE,
            "anime stream source is rate limited; retry shortly",
        ),
        ResolveError::Busy => (
            StatusCode::SERVICE_UNAVAILABLE,
            "stream proxy is at upstream capacity; retry shortly",
        ),
        ResolveError::TooLarge => (
            StatusCode::BAD_GATEWAY,
            "upstream media segment exceeds the configured safety limit",
        ),
    };
    let mut response = (status, negative_message(message)).into_response();
    if matches!(error, ResolveError::RateLimited | ResolveError::Busy) {
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static("5"));
    }
    response
}

pub(super) async fn master_handler(
    state: &Arc<AppState>,
    key: &EpisodeKey,
    uri: &Uri,
) -> Result<Response, ResolveError> {
    let (source, master) = source_master(state, key).await?;
    warm_source(state, &source);
    let source_generation = source.generation.to_string();
    let anilist_ids = received_anilist_ids(uri);
    let stream_path = stream_base_path(key);
    if is_master_playlist(&master) {
        let query = query_string(key, &anilist_ids, &[]);
        let rewritten = rewrite_hls_master(
            &master,
            |variant| {
                format!(
                    "{stream_path}/variant?{query}&source_generation={source_generation}&variant={variant}"
                )
            },
            |resource| {
                format!(
                    "{stream_path}/resource?{query}&source_generation={source_generation}&master_resource={resource}"
                )
            },
        )?;
        Ok(playlist_response(rewritten))
    } else {
        let query = query_string(key, &anilist_ids, &[]);
        let rewritten = rewrite_hls(&master, |resource| {
            format!(
                "{stream_path}/resource?{query}&source_generation={source_generation}&variant=-1&resource={resource}"
            )
        })?;
        Ok(playlist_response(rewritten))
    }
}

pub(super) async fn variant_handler(
    state: &AppState,
    key: &EpisodeKey,
    uri: &Uri,
) -> Result<Response, ResolveError> {
    let variant = query_value(uri, "variant")
        .and_then(|value| value.parse::<i32>().ok())
        .ok_or(ResolveError::Invalid)?;
    let requested_generation = requested_source_generation(uri)?;
    let (source, _, playlist) = media_playlist(state, key, variant, requested_generation).await?;
    let query = query_string(
        key,
        &received_anilist_ids(uri),
        &[
            ("source_generation", source.generation.to_string()),
            ("variant", variant.to_string()),
        ],
    );
    let rewritten = rewrite_hls(&playlist, |resource| {
        format!("{}/resource?{query}&resource={resource}", stream_base_path(key))
    })?;
    Ok(playlist_response(rewritten))
}
