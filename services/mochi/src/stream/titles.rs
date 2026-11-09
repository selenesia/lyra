use super::{
    fetch_playlist, is_master_playlist, parse_hls_qualities, prepare_source, read_body_limited,
    send_with_retry, source_label, subtitle_tracks,
    track_language, with_master, EpisodeKey, ResolveError, ResolvedSource, SourceMetadata,
    StreamProvider, SubtitleTrack, TitleKey, TitleKind, MAX_METADATA_BYTES,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use reqwest::header::{ACCEPT, REFERER};
use serde_json::{json, Value};
use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    sync::{Arc, LazyLock},
    task::Poll,
    time::Duration,
};
use tokio::sync::mpsc;
use url::Url;

pub(super) const PAGE_REFERER: &str = "https://framextv.cc/";
pub(super) const PAGE_ORIGIN: &str = "https://framextv.cc";
pub(super) const RESOLUTION_BUDGET: Duration = Duration::from_secs(18);
const API: &str = "https://api.framextv.tech";
const MAX_PROVIDERS: usize = 8;
const CONCURRENT_PROVIDERS: usize = 3;
const MAX_CANDIDATES: usize = 4;
const MAX_SOURCES: usize = 16;
const MAX_TRACKS: usize = 80;
const MAX_TRACKS_PER_HOST_LANGUAGE: usize = 2;
const NON_LANGUAGES: [&str; 9] = ["", "sub", "dub", "auto", "multi", "mul", "original", "default", "raw"];
const CANDIDATE_TIMEOUT: Duration = Duration::from_secs(6);
const PROVIDER_TIMEOUT: Duration = Duration::from_secs(8);
const REGISTRY_TIMEOUT: Duration = Duration::from_millis(1500);
const QUALITY_SEARCH_BUDGET: Duration = Duration::from_secs(16);
const QUALITY_SETTLE_GRACE: Duration = Duration::from_millis(750);
const SUBTITLE_TIMEOUT: Duration = Duration::from_secs(5);
const UNAVAILABLE_STATUSES: [&str; 3] = ["down", "unavailable", "disabled"];

type EpisodeIdentity = (TitleKey, i32);

static RESPONSES: LazyLock<moka::future::Cache<(EpisodeIdentity, String), Arc<Value>>> =
    LazyLock::new(|| {
        moka::future::Cache::builder()
            .max_capacity(512)
            .time_to_live(Duration::from_secs(2 * 60))
            .support_invalidation_closures()
            .build()
    });

static SUBTITLES: LazyLock<moka::future::Cache<EpisodeIdentity, Arc<Vec<SubtitleTrack>>>> =
    LazyLock::new(|| {
        moka::future::Cache::builder()
            .max_capacity(512)
            .time_to_live(Duration::from_secs(30 * 60))
            .build()
    });

static REGISTRY: LazyLock<moka::future::Cache<(), Arc<Vec<String>>>> = LazyLock::new(|| {
    moka::future::Cache::builder()
        .max_capacity(1)
        .time_to_live(Duration::from_secs(10 * 60))
        .build()
});

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Candidate {
    pub(super) url: String,
    pub(super) language: String,
    pub(super) height: Option<u32>,
    pub(super) server: Option<String>,
}

fn title_params(title: TitleKey, episode: i32) -> Vec<(&'static str, String)> {
    let mut params = vec![("type", title.kind.id().to_string()), ("id", title.tmdb_id.to_string())];
    if title.kind == TitleKind::Tv {
        params.push(("season", title.season.to_string()));
        params.push(("episode", episode.to_string()));
    }
    params
}

pub(super) fn api_url(path: &str, params: &[(&str, String)]) -> String {
    Url::parse_with_params(&format!("{API}{path}"), params)
        .map(|url| url.to_string())
        .unwrap_or_default()
}

async fn api_json(client: &reqwest::Client, url: &str) -> Result<Value, ResolveError> {
    let response = send_with_retry(|| {
        client
            .get(url)
            .header(REFERER, PAGE_REFERER)
            .header("origin", PAGE_ORIGIN)
            .header(ACCEPT, "application/json")
    })
    .await?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(ResolveError::NotFound);
    }
    if !response.status().is_success() && response.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(ResolveError::Upstream);
    }
    let body = read_body_limited(response, MAX_METADATA_BYTES).await?;
    serde_json::from_slice(&body).map_err(|_| ResolveError::Upstream)
}

pub(super) fn stream_payload(value: Value) -> Value {
    match value.get("detail") {
        Some(detail) if detail.get("success").is_some() => detail.clone(),
        _ => value,
    }
}

pub(super) fn playable(payload: &Value) -> bool {
    payload.get("success").and_then(Value::as_bool) == Some(true)
        && payload
            .get("sources")
            .and_then(Value::as_array)
            .is_some_and(|sources| !sources.is_empty())
}

pub(super) fn payload_failure(payload: &Value) -> ResolveError {
    match payload.get("code").and_then(Value::as_str) {
        Some("busy") => ResolveError::Busy,
        Some("rate_limited" | "rate_limit") => ResolveError::RateLimited,
        _ => ResolveError::NotFound,
    }
}

fn provider_id(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()
        && value.len() <= 40
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'))
    .then(|| value.to_string())
}

pub(super) fn alternates(payload: &Value) -> Vec<String> {
    payload
        .get("alternates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter_map(provider_id)
        .collect()
}

pub(super) fn available_providers(payload: &Value) -> Vec<String> {
    let mut providers: Vec<_> = payload
        .get("providers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|provider| {
            provider
                .get("category")
                .and_then(Value::as_str)
                .is_none_or(|category| category == "movie_tv")
                && provider
                    .get("status")
                    .and_then(Value::as_str)
                    .is_none_or(|status| !UNAVAILABLE_STATUSES.contains(&status))
        })
        .filter_map(|provider| {
            let id = provider.get("id")?.as_str().and_then(provider_id)?;
            let height = provider
                .get("tagline")
                .and_then(Value::as_str)
                .and_then(label_height)
                .unwrap_or(0);
            Some((id, height))
        })
        .collect();
    providers.sort_by(|left, right| right.1.cmp(&left.1));
    providers.into_iter().map(|(id, _)| id).collect()
}

async fn provider_response(
    client: &reqwest::Client,
    identity: EpisodeIdentity,
    provider: &str,
) -> Result<Arc<Value>, ResolveError> {
    let cache_key = (identity, provider.to_string());
    if let Some(payload) = RESPONSES.get(&cache_key).await {
        return Ok(payload);
    }
    let mut params = title_params(identity.0, identity.1);
    if !provider.is_empty() {
        params.push(("provider", provider.to_string()));
    }
    let payload = Arc::new(stream_payload(
        api_json(client, &api_url("/api/stream", &params)).await?,
    ));
    if playable(&payload) {
        RESPONSES.insert(cache_key, payload.clone()).await;
    }
    Ok(payload)
}

async fn registry(client: &reqwest::Client) -> Arc<Vec<String>> {
    if let Some(providers) = REGISTRY.get(&()).await {
        return providers;
    }
    match api_json(client, &api_url("/api/providers", &[])).await {
        Ok(payload) => {
            let providers = Arc::new(available_providers(&payload));
            if !providers.is_empty() {
                REGISTRY.insert((), providers.clone()).await;
            }
            providers
        }
        Err(_) => Arc::new(Vec::new()),
    }
}

pub(super) fn language_code(value: &str) -> String {
    let lower = value.trim().to_lowercase();
    if NON_LANGUAGES.contains(&lower.as_str()) {
        return "und".into();
    }
    let code = match lower.as_str() {
        "hindi" => "hi",
        "tamil" => "ta",
        "telugu" => "te",
        "kannada" => "kn",
        "malayalam" => "ml",
        "bengali" | "bangla" => "bn",
        "marathi" => "mr",
        "punjabi" => "pa",
        "gujarati" => "gu",
        "urdu" => "ur",
        "odia" | "oriya" => "or",
        "polish" => "pl",
        "dutch" => "nl",
        "hungarian" => "hu",
        "czech" => "cs",
        "romanian" => "ro",
        "finnish" => "fi",
        "hebrew" => "he",
        "persian" | "farsi" => "fa",
        "filipino" | "tagalog" => "tl",
        _ => "",
    };
    if !code.is_empty() {
        return code.to_string();
    }
    track_language(&json!({ "language": value, "label": value }))
}

pub(super) fn label_height(label: &str) -> Option<u32> {
    let lower = label.to_ascii_lowercase();
    if lower.contains("4k") || lower.contains("uhd") {
        return Some(2160);
    }
    let bytes = lower.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if !bytes[index].is_ascii_digit() {
            index += 1;
            continue;
        }
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if bytes.get(index) == Some(&b'p') && (start == 0 || !bytes[start - 1].is_ascii_alphanumeric()) {
            if let Ok(height) = lower[start..index].parse::<u32>() {
                if (144..=4320).contains(&height) {
                    return Some(height);
                }
            }
        }
    }
    None
}

pub(super) fn source_language(candidate: &Value) -> String {
    let tracks = candidate.get("audioTracks").and_then(Value::as_array);
    if let Some(track) = tracks.and_then(|tracks| {
        tracks
            .iter()
            .find(|track| track.get("default").and_then(Value::as_bool) == Some(true))
            .or_else(|| tracks.first())
    }) {
        let code = language_code(
            track
                .get("language")
                .or_else(|| track.get("label"))
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
        if code != "und" {
            return code;
        }
    }
    for field in ["language", "audio", "lang"] {
        if let Some(value) = candidate.get(field).and_then(Value::as_str) {
            let code = language_code(value);
            if code != "und" {
                return code;
            }
        }
    }
    candidate
        .get("quality")
        .and_then(Value::as_str)
        .and_then(|label| label.rsplit_once('|'))
        .map(|(_, language)| language_code(language))
        .unwrap_or_else(|| "und".into())
}

pub(super) fn source_url(value: &str) -> Option<String> {
    let url = Url::parse(API).ok()?.join(value.trim()).ok()?;
    (url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.fragment().is_none()
        && crate::safe_dns::validate_public_target(&url).is_ok())
    .then(|| url.to_string())
}

pub(super) fn candidates(payload: &Value) -> Vec<Candidate> {
    let mut candidates = Vec::<Candidate>::new();
    for candidate in payload
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if candidate
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| !kind.eq_ignore_ascii_case("hls"))
        {
            continue;
        }
        let Some(url) = candidate
            .get("url")
            .or_else(|| candidate.get("file"))
            .and_then(Value::as_str)
            .and_then(source_url)
        else {
            continue;
        };
        if candidates.iter().any(|existing| existing.url == url) {
            continue;
        }
        candidates.push(Candidate {
            url,
            language: source_language(candidate),
            height: candidate
                .get("quality")
                .and_then(Value::as_str)
                .and_then(label_height),
            server: source_label(candidate.get("server")),
        });
    }
    candidates.sort_by(|left, right| right.height.cmp(&left.height));
    candidates.truncate(MAX_SOURCES);
    candidates
}

pub(super) fn languages(candidates: &[Candidate]) -> Vec<String> {
    let mut languages = Vec::new();
    for candidate in candidates {
        if candidate.language != "und" && !languages.contains(&candidate.language) {
            languages.push(candidate.language.clone());
        }
    }
    languages
}

fn bandwidth(height: u32) -> u64 {
    match height {
        2160.. => 16_000_000,
        1440.. => 9_000_000,
        1080.. => 5_000_000,
        720.. => 2_800_000,
        480.. => 1_200_000,
        360.. => 800_000,
        _ => 500_000,
    }
}

pub(super) fn synthetic_master(variants: &[&Candidate]) -> String {
    let mut master = String::from("#EXTM3U\n#EXT-X-VERSION:3\n");
    for variant in variants {
        let height = variant.height.unwrap_or(0);
        let width = (height * 16 / 9 + 1) & !1;
        master.push_str(&format!(
            "#EXT-X-STREAM-INF:BANDWIDTH={},RESOLUTION={width}x{height}\n{}\n",
            bandwidth(height),
            variant.url
        ));
    }
    master
}

pub(super) fn language_order(candidates: &[Candidate], requested: &str) -> Vec<String> {
    let mut order = Vec::<String>::new();
    for language in [requested, "und", "en"]
        .into_iter()
        .map(str::to_string)
        .chain(candidates.iter().map(|candidate| candidate.language.clone()))
    {
        if !order.contains(&language) && candidates.iter().any(|candidate| candidate.language == language) {
            order.push(language);
        }
    }
    order
}

pub(super) fn plan(
    candidates: &[Candidate],
    key: &EpisodeKey,
    title: TitleKey,
    tracks: &[SubtitleTrack],
) -> Vec<ResolvedSource> {
    let available = languages(candidates);
    let mut sources = Vec::new();
    for language in language_order(candidates, &key.language) {
        let group: Vec<_> = candidates
            .iter()
            .filter(|candidate| candidate.language == language)
            .collect();
        let mut variants: Vec<&Candidate> = Vec::new();
        for candidate in &group {
            if candidate.height.is_some()
                && !variants
                    .iter()
                    .any(|variant| variant.height == candidate.height)
            {
                variants.push(candidate);
            }
        }
        variants.sort_by(|left, right| right.height.cmp(&left.height));
        let mut push = |playlist_url: &str, master: String, server: Option<String>| {
            sources.push(ResolvedSource {
                provider: StreamProvider::Title,
                playlist_url: playlist_url.to_string(),
                fallback_playlist_url: None,
                master: Arc::new(master),
                tracks: tracks.to_vec(),
                internal_id: format!(
                    "{}:{}:{}:{}:{language}:{}",
                    title.kind.id(),
                    title.tmdb_id,
                    title.season,
                    key.episode,
                    sources.len()
                ),
                generation: 0,
                language: Some(language.clone()),
                metadata: SourceMetadata {
                    server,
                    languages: available.clone(),
                    ..SourceMetadata::default()
                },
            });
        };
        if variants.len() >= 2 {
            push(&variants[0].url, synthetic_master(&variants), variants[0].server.clone());
        }
        for candidate in group {
            let master = candidate
                .height
                .map(|_| synthetic_master(&[candidate]))
                .unwrap_or_default();
            push(&candidate.url, master, candidate.server.clone());
        }
    }
    sources
}

pub(super) fn tracks(payloads: &[&Value]) -> Vec<SubtitleTrack> {
    let tracks: Vec<_> = payloads
        .iter()
        .flat_map(|payload| {
            payload
                .get("subtitles")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|track| {
            let url = source_url(track.get("url").or_else(|| track.get("file"))?.as_str()?)?;
            let language = track
                .get("lang")
                .or_else(|| track.get("language"))
                .and_then(Value::as_str)
                .map(language_code)
                .unwrap_or_else(|| "und".into());
            Some(json!({
                "file": url,
                "label": track.get("label").or_else(|| track.get("language")).cloned().unwrap_or(Value::Null),
                "language": language,
                "default": track.get("isDefault").or_else(|| track.get("default")).cloned().unwrap_or(Value::Bool(false)),
            }))
        })
        .collect();
    let mut kept = Vec::<SubtitleTrack>::new();
    let mut counts = std::collections::HashMap::<(String, String), usize>::new();
    for track in subtitle_tracks(&json!({ "tracks": tracks })) {
        let host = Url::parse(&track.url)
            .ok()
            .and_then(|url| url.host_str().map(str::to_string))
            .unwrap_or_default();
        let count = counts.entry((track.language.clone(), host)).or_default();
        if *count >= MAX_TRACKS_PER_HOST_LANGUAGE {
            continue;
        }
        *count += 1;
        kept.push(track);
        if kept.len() >= MAX_TRACKS {
            break;
        }
    }
    kept
}

async fn additional_tracks(client: &reqwest::Client, identity: EpisodeIdentity) -> Arc<Vec<SubtitleTrack>> {
    if let Some(tracks) = SUBTITLES.get(&identity).await {
        return tracks;
    }
    let url = api_url("/api/subtitles", &title_params(identity.0, identity.1));
    match tokio::time::timeout(SUBTITLE_TIMEOUT, api_json(client, &url)).await {
        Ok(Ok(payload)) if payload.get("success").and_then(Value::as_bool) == Some(true) => {
            let tracks = Arc::new(tracks(&[&payload]));
            SUBTITLES.insert(identity, tracks.clone()).await;
            tracks
        }
        _ => Arc::new(Vec::new()),
    }
}

fn worse(current: ResolveError, next: ResolveError) -> ResolveError {
    let rank = |error: ResolveError| match error {
        ResolveError::Busy => 3,
        ResolveError::RateLimited => 2,
        ResolveError::Upstream => 1,
        _ => 0,
    };
    if rank(next) > rank(current) {
        next
    } else {
        current
    }
}

fn source_rank(source: &ResolvedSource, requested: &str) -> (u8, u32, u64) {
    let language = source.language.as_deref().unwrap_or("und");
    let language_rank = if language == requested || (requested == "en" && language == "und") {
        2
    } else if language == "und" {
        1
    } else {
        0
    };
    let (height, bitrate) = parse_hls_qualities(&source.master)
        .into_iter()
        .map(|(_, _, height, bitrate, _)| (height, bitrate))
        .max()
        .unwrap_or_default();
    (language_rank, height, bitrate)
}

fn keep_best(best: &mut Option<ResolvedSource>, source: ResolvedSource, requested: &str) {
    if best
        .as_ref()
        .is_none_or(|current| source_rank(&source, requested) > source_rank(current, requested))
    {
        *best = Some(source);
    }
}

fn settle_deadline(
    best: &Option<ResolvedSource>,
    requested: &str,
    deadline: &mut tokio::time::Instant,
) {
    if best.as_ref().is_some_and(|source| {
        let (language, height, _) = source_rank(source, requested);
        language == 2 && height >= 2160
    }) {
        *deadline = (*deadline).min(tokio::time::Instant::now() + QUALITY_SETTLE_GRACE);
    }
}

async fn best_source(
    sources: impl futures_util::Stream<Item = Result<ResolvedSource, ResolveError>>,
    requested: &str,
    budget: Duration,
) -> Result<ResolvedSource, ResolveError> {
    futures_util::pin_mut!(sources);
    let mut deadline = tokio::time::Instant::now() + budget;
    let mut best = None;
    let mut failure = ResolveError::NotFound;
    loop {
        let result = match tokio::time::timeout_at(deadline, sources.next()).await {
            Ok(Some(result)) => result,
            Ok(None) => break,
            Err(_) => {
                failure = worse(failure, ResolveError::Upstream);
                break;
            }
        };
        match result {
            Ok(source) => keep_best(&mut best, source, requested),
            Err(error) => failure = worse(failure, error),
        }
        settle_deadline(&best, requested, &mut deadline);
    }
    best.ok_or(failure)
}

async fn prepare_title_source(
    client: &reqwest::Client,
    mut source: ResolvedSource,
) -> Result<ResolvedSource, ResolveError> {
    let playlist = fetch_playlist(client, &source.playlist_url, StreamProvider::Title).await?;
    if is_master_playlist(&playlist) || source.master.is_empty() {
        source.master = playlist;
    }
    prepare_source(client, source).await
}

async fn resolve_provider(
    client: &reqwest::Client,
    key: &EpisodeKey,
    title: TitleKey,
    provider: String,
    ready: mpsc::UnboundedSender<Result<ResolvedSource, ResolveError>>,
) -> Vec<String> {
    let payload = match tokio::time::timeout(
        PROVIDER_TIMEOUT,
        provider_response(client, (title, key.episode), &provider),
    )
    .await
    {
        Ok(Ok(payload)) => payload,
        Ok(Err(error)) => {
            let _ = ready.send(Err(error));
            return Vec::new();
        }
        Err(_) => {
            let _ = ready.send(Err(ResolveError::Upstream));
            return Vec::new();
        }
    };
    let alternatives = alternates(&payload);
    if !playable(&payload) {
        let _ = ready.send(Err(payload_failure(&payload)));
        return alternatives;
    }
    let mut sources = plan(&candidates(&payload), key, title, &tracks(&[&payload]));
    sources.sort_by(|left, right| source_rank(right, &key.language).cmp(&source_rank(left, &key.language)));
    let pending = futures_util::stream::iter(sources.into_iter().take(MAX_CANDIDATES))
        .map(|source| async move {
            tokio::time::timeout(CANDIDATE_TIMEOUT, prepare_title_source(client, source))
                .await
                .unwrap_or(Err(ResolveError::Upstream))
        })
        .buffer_unordered(2);
    report_sources(pending, ready).await;
    alternatives
}

async fn report_sources(
    sources: impl futures_util::Stream<Item = Result<ResolvedSource, ResolveError>>,
    ready: mpsc::UnboundedSender<Result<ResolvedSource, ResolveError>>,
) {
    futures_util::pin_mut!(sources);
    let deadline = tokio::time::Instant::now() + CANDIDATE_TIMEOUT;
    loop {
        let result = match tokio::time::timeout_at(deadline, sources.next()).await {
            Ok(Some(result)) => result,
            Ok(None) => break,
            Err(_) => {
                let _ = ready.send(Err(ResolveError::Upstream));
                break;
            }
        };
        if ready.send(result).is_err() {
            break;
        }
    }
}

async fn search_sources<F>(
    providers: impl Future<Output = Arc<Vec<String>>>,
    mut resolve: impl FnMut(String, mpsc::UnboundedSender<Result<ResolvedSource, ResolveError>>) -> F,
    requested: &str,
) -> Result<ResolvedSource, ResolveError>
where
    F: Future<Output = Vec<String>>,
{
    let (ready, mut sources) = mpsc::unbounded_channel();
    let discovery = async {
        let registry = tokio::time::timeout(REGISTRY_TIMEOUT, providers);
        tokio::pin!(registry);
        let mut registry_done = false;
        let mut queue = VecDeque::from([String::new()]);
        let mut tried = HashSet::new();
        let mut pending = FuturesUnordered::new();
        loop {
            while (registry_done || tried.is_empty())
                && pending.len() < CONCURRENT_PROVIDERS
                && tried.len() < MAX_PROVIDERS
            {
                let Some(provider) = queue.pop_front() else {
                    break;
                };
                if tried.insert(provider.clone()) {
                    pending.push(resolve(provider, ready.clone()));
                }
            }
            if pending.is_empty() && registry_done {
                break;
            }
            let alternatives = tokio::select! {
                providers = &mut registry, if !registry_done => {
                    registry_done = true;
                    if let Ok(providers) = providers {
                        for provider in providers.iter().rev() {
                            if !tried.contains(provider) {
                                queue.retain(|queued| queued != provider);
                                queue.push_front(provider.clone());
                            }
                        }
                    }
                    Vec::new()
                }
                result = pending.next(), if !pending.is_empty() => result.unwrap_or_default(),
            };
            for provider in alternatives {
                if !tried.contains(&provider) && !queue.contains(&provider) {
                    queue.push_back(provider);
                }
            }
        }
    };
    tokio::pin!(discovery);
    let mut discovery_done = false;
    let candidates = futures_util::stream::poll_fn(|context| {
        if !discovery_done && discovery.as_mut().poll(context).is_ready() {
            discovery_done = true;
        }
        match sources.poll_recv(context) {
            Poll::Pending if discovery_done => Poll::Ready(None),
            result => result,
        }
    });
    best_source(candidates, requested, QUALITY_SEARCH_BUDGET).await
}

async fn resolve_sources(
    client: &reqwest::Client,
    key: &EpisodeKey,
    title: TitleKey,
) -> Result<ResolvedSource, ResolveError> {
    search_sources(
        registry(client),
        |provider, ready| resolve_provider(client, key, title, provider, ready),
        &key.language,
    )
    .await
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<ResolvedSource, ResolveError> {
    let title = key.title.ok_or(ResolveError::NotFound)?;
    let (source, additional) = tokio::join!(
        resolve_sources(client, key, title),
        additional_tracks(client, (title, key.episode))
    );
    let mut source = source?;
    for track in additional.iter() {
        if source.tracks.len() >= MAX_TRACKS {
            break;
        }
        if !source.tracks.iter().any(|existing| existing.url == track.url) {
            source.tracks.push(track.clone());
        }
    }
    let master = source.master.clone();
    Ok(with_master(source, master))
}

pub(super) async fn invalidate(key: &EpisodeKey) {
    let Some(title) = key.title else {
        return;
    };
    let identity = (title, key.episode);
    let _ = RESPONSES.invalidate_entries_if(move |(entry, _), _| *entry == identity);
}

pub(super) async fn reclaim_caches() {
    RESPONSES.invalidate_all();
    SUBTITLES.invalidate_all();
    REGISTRY.invalidate_all();
    tokio::join!(
        RESPONSES.run_pending_tasks(),
        SUBTITLES.run_pending_tasks(),
        REGISTRY.run_pending_tasks()
    );
}

