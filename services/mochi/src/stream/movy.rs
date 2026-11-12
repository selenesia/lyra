use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::sync::Mutex;

pub(super) const REFERER_URL: &str = "https://www.movy.sx/";
pub(super) const ORIGIN: &str = "https://www.movy.sx";
const API: &str = "https://api.wecollege.net";
const METADATA: &str = "https://db.wecollege.net";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);
const MAX_INIT_BYTES: usize = 128 * 1024;
pub(super) fn resolution_budget(key: &EpisodeKey) -> Duration {
    Duration::from_secs(if key.title.is_some() { 18 } else { 14 })
}
const SERVERS: [(&str, &str); 18] = [
    ("miami", "original"),
    ("boise", "original"),
    ("nashville", "original"),
    ("chicago", "original"),
    ("vegas", "original"),
    ("reno", "original"),
    ("oakland", "original"),
    ("seattle", "original"),
    ("phoenix", "original"),
    ("atlanta", "original"),
    ("portland", "original"),
    ("austin", "en"),
    ("dallas", "original"),
    ("munich", "de"),
    ("berlin", "de"),
    ("paris", "fr"),
    ("delhi", "hi"),
    ("cancun", "es"),
];

type ResponseKey = (TitleKey, i32, &'static str);

static RESPONSES: LazyLock<Cache<ResponseKey, Arc<Value>>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(16 * 1024 * 1024)
        .weigher(|_: &ResponseKey, value: &Arc<Value>| {
            value.to_string().len().min(u32::MAX as usize) as u32
        })
        .time_to_live(Duration::from_secs(90))
        .support_invalidation_closures()
        .build()
});
static FAILED_SERVERS: LazyLock<Cache<ResponseKey, ()>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(10_000)
        .time_to_live(Duration::from_secs(60))
        .build()
});
static SEEDS: LazyLock<Cache<u32, (String, Instant)>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(1024)
        .time_to_live(Duration::from_secs(25))
        .build()
});

static LOOKUPS: LazyLock<Cache<String, Arc<Value>>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(16 * 1024 * 1024)
        .weigher(|url: &String, value: &Arc<Value>| {
            (url.len() + value.to_string().len() + 128).min(u32::MAX as usize) as u32
        })
        .time_to_live(Duration::from_secs(90))
        .build()
});
static IDENTITIES: LazyLock<Cache<(i64, i64, i32), (TitleKey, i32)>> = LazyLock::new(|| {
    Cache::builder()
        .max_capacity(1024)
        .time_to_live(Duration::from_secs(24 * 60 * 60))
        .build()
});
static LOOKUP_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
static COOLDOWNS: LazyLock<Mutex<std::collections::HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

fn managed_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("api.wecollege.net" | "db.wecollege.net" | "subtitles.vidy.st")
    )
}

pub(super) fn admit_request(url: &Url) -> Result<(), ResolveError> {
    if managed_host(url)
        && COOLDOWNS
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(url.host_str().unwrap_or_default())
            .is_some_and(|until| *until > Instant::now())
    {
        return Err(ResolveError::RateLimited);
    }
    Ok(())
}

fn cooldown(headers: &HeaderMap, now: std::time::SystemTime) -> Duration {
    headers
        .get(RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .parse::<u64>()
                .ok()
                .map(Duration::from_secs)
                .or_else(|| {
                    httpdate::parse_http_date(value)
                        .ok()?
                        .duration_since(now)
                        .ok()
                })
        })
        .unwrap_or(Duration::from_secs(60))
        .max(Duration::from_secs(1))
}

pub(super) fn observe_response(response: &reqwest::Response) -> Result<(), ResolveError> {
    if !managed_host(response.url()) {
        return Ok(());
    }
    let error = match response.status() {
        StatusCode::TOO_MANY_REQUESTS => ResolveError::RateLimited,
        StatusCode::FORBIDDEN | StatusCode::SERVICE_UNAVAILABLE => ResolveError::Upstream,
        _ => return Ok(()),
    };
    let delay = cooldown(response.headers(), std::time::SystemTime::now());
    let until = Instant::now()
        .checked_add(delay)
        .unwrap_or_else(|| Instant::now() + Duration::from_secs(365 * 24 * 60 * 60));
    COOLDOWNS
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entry(response.url().host_str().unwrap_or_default().to_string())
        .and_modify(|previous| *previous = (*previous).max(until))
        .or_insert(until);
    Err(error)
}

async fn lookup(client: &reqwest::Client, url: String) -> Result<Arc<Value>, ResolveError> {
    LOOKUPS
        .try_get_with(url.clone(), async {
            let _slot = LOOKUP_SLOTS.try_acquire().map_err(|_| ResolveError::Busy)?;
            tokio::time::timeout(REQUEST_TIMEOUT, async {
                let response = send_with_retry(|| {
                    client
                        .get(&url)
                        .headers(StreamProvider::Movy.headers())
                        .header(ACCEPT, "application/json")
                })
                .await?;
                if matches!(
                    response.status(),
                    StatusCode::NOT_FOUND | StatusCode::ACCEPTED
                ) {
                    return Err(ResolveError::NotFound);
                }
                if !response.status().is_success() {
                    return Err(ResolveError::Upstream);
                }
                let bytes = read_body_limited(response, MAX_METADATA_BYTES).await?;
                serde_json::from_slice(&bytes)
                    .map(Arc::new)
                    .map_err(|_| ResolveError::Upstream)
            })
            .await
            .unwrap_or(Err(ResolveError::Upstream))
        })
        .await
        .map_err(|error| *error)
}

fn number(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .or_else(|| value.as_str()?.parse().ok())
}

fn mapping(payload: &Value, key: &EpisodeKey) -> Result<(u32, Option<u32>), ResolveError> {
    let ids = payload.get("mappings").ok_or(ResolveError::NotFound)?;
    if (key.anilist_id > 0 && ids.get("anilist_id").and_then(Value::as_i64) != Some(key.anilist_id))
        || (key.mal_id > 0 && ids.get("mal_id").and_then(Value::as_i64) != Some(key.mal_id))
    {
        return Err(ResolveError::NotFound);
    }
    let tmdb = ids
        .get("themoviedb_id")
        .and_then(number)
        .filter(|id| *id > 0)
        .ok_or(ResolveError::NotFound)?;
    if ids.get("type").and_then(Value::as_str) == Some("MOVIE") {
        return (key.episode == 1)
            .then_some((tmdb, None))
            .ok_or(ResolveError::NotFound);
    }
    let tvdb = payload
        .get("episodes")
        .and_then(|episodes| episodes.get(key.episode.to_string()))
        .and_then(|episode| episode.get("tvdbId"))
        .and_then(number)
        .filter(|id| *id > 0)
        .ok_or(ResolveError::NotFound)?;
    Ok((tmdb, Some(tvdb)))
}

fn mapped_episode(payload: &Value, tmdb: u32) -> Result<(TitleKey, i32), ResolveError> {
    let episodes = payload
        .get("tv_episode_results")
        .and_then(Value::as_array)
        .ok_or(ResolveError::NotFound)?;
    let mut matches = episodes
        .iter()
        .filter(|episode| episode.get("show_id").and_then(number) == Some(tmdb));
    let episode = matches.next().ok_or(ResolveError::NotFound)?;
    if matches.next().is_some() {
        return Err(ResolveError::NotFound);
    }
    let season = episode
        .get("season_number")
        .and_then(number)
        .and_then(|value| u16::try_from(value).ok())
        .ok_or(ResolveError::NotFound)?;
    let episode = episode
        .get("episode_number")
        .and_then(number)
        .and_then(|value| i32::try_from(value).ok())
        .filter(|value| *value > 0)
        .ok_or(ResolveError::NotFound)?;
    Ok((
        TitleKey {
            kind: TitleKind::Tv,
            tmdb_id: tmdb,
            season,
        },
        episode,
    ))
}

async fn identity(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<(TitleKey, i32), ResolveError> {
    if let Some(title) = key.title {
        return Ok((title, key.episode));
    }
    IDENTITIES
        .try_get_with((key.anilist_id, key.mal_id, key.episode), async {
            let query = if key.anilist_id > 0 {
                format!("anilist_id={}", key.anilist_id)
            } else {
                format!("mal_id={}", key.mal_id)
            };
            let payload = lookup(client, format!("https://api.ani.zip/mappings?{query}")).await?;
            let (tmdb, tvdb_episode) = mapping(&payload, key)?;
            match tvdb_episode {
                None => Ok((
                    TitleKey {
                        kind: TitleKind::Movie,
                        tmdb_id: tmdb,
                        season: 0,
                    },
                    1,
                )),
                Some(tvdb) => {
                    let payload = lookup(
                        client,
                        format!("{METADATA}/3/find/{tvdb}?external_source=tvdb_id"),
                    )
                    .await?;
                    mapped_episode(&payload, tmdb)
                }
            }
        })
        .await
        .map_err(|error| *error)
}

fn boxes(mut bytes: &[u8]) -> impl Iterator<Item = (&[u8], &[u8])> {
    std::iter::from_fn(move || {
        let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        let kind = bytes.get(4..8)?;
        let (size, header) = match size {
            0 => (bytes.len(), 8),
            1 => (
                usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?,
                16,
            ),
            _ => (size, 8),
        };
        if size < header || size > bytes.len() {
            bytes = &[];
            return None;
        }
        let payload = &bytes[header..size];
        bytes = &bytes[size..];
        Some((kind, payload))
    })
}

fn audio_language(bytes: &[u8]) -> Option<String> {
    let moov = boxes(bytes).find(|(kind, _)| *kind == b"moov")?.1;
    for (_, track) in boxes(moov).filter(|(kind, _)| *kind == b"trak") {
        let Some((_, media)) = boxes(track).find(|(kind, _)| *kind == b"mdia") else {
            continue;
        };
        let sound = boxes(media)
            .any(|(kind, payload)| kind == b"hdlr" && payload.get(8..12) == Some(b"soun"));
        if !sound {
            continue;
        }
        let header = boxes(media).find(|(kind, _)| *kind == b"mdhd")?.1;
        let offset = match header.first()? {
            0 => 20,
            1 => 32,
            _ => return None,
        };
        let code = u16::from_be_bytes(header.get(offset..offset + 2)?.try_into().ok()?);
        let letters = [(code >> 10) & 31, (code >> 5) & 31, code & 31];
        if letters.iter().any(|letter| !(1..=26).contains(letter)) {
            return None;
        }
        let language: String = letters
            .into_iter()
            .map(|letter| char::from(letter as u8 + 96))
            .collect();
        return Some(titles::language_code(&language));
    }
    None
}

async fn source_language(
    client: &reqwest::Client,
    url: &str,
    master: &str,
    requested: &str,
) -> Option<String> {
    let audio = parse_hls_audio_tracks(master);
    if let Some((_, language, _)) = audio
        .iter()
        .find(|track| titles::language_code(&track.1) == requested)
        .or_else(|| audio.iter().find(|track| track.2))
        .or_else(|| audio.first())
    {
        if language != "und" {
            return Some(titles::language_code(language));
        }
    }
    let media_url = hls_variant_references(url, master)
        .last()
        .cloned()
        .unwrap_or_else(|| url.to_string());
    let media = fetch_playlist(client, &media_url, StreamProvider::Movy)
        .await
        .ok()?;
    let init = media
        .lines()
        .find_map(|line| quoted_uri(line.strip_prefix("#EXT-X-MAP:")?).map(|(_, _, uri)| uri))?;
    let init_url = absolute_url(&media_url, init)?;
    let response = send_with_retry(|| {
        client
            .get(&init_url)
            .headers(StreamProvider::Movy.headers())
    })
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = read_body_limited(response, MAX_INIT_BYTES).await.ok()?;
    audio_language(&bytes)
}

async fn tracks(client: &reqwest::Client, title: TitleKey, episode: i32) -> Vec<SubtitleTrack> {
    let mut url = Url::parse("https://subtitles.vidy.st/search").unwrap();
    url.query_pairs_mut()
        .append_pair("id", &title.tmdb_id.to_string());
    if title.kind == TitleKind::Tv {
        url.query_pairs_mut()
            .append_pair("season", &title.season.to_string())
            .append_pair("episode", &episode.to_string());
    }
    let Ok(payload) = lookup(client, url.to_string()).await else {
        return Vec::new();
    };
    let subtitles: Vec<_> = payload.as_array().into_iter().flatten().map(|track| {
        json!({"url": track.get("url"), "lang": track.get("language"), "label": track.get("display")})
    }).collect();
    titles::tracks(&[&json!({"subtitles": subtitles})])
}

fn requested_language(key: &EpisodeKey, language: Option<&str>) -> bool {
    match (key.title, language) {
        (None, Some("ja")) => key.language == "sub",
        (None, Some("en")) => key.language == "dub",
        (None, _) => false,
        (Some(_), Some(language)) if language != "und" => {
            language == key.language.split('-').next().unwrap_or_default()
        }
        (Some(_), _) => true,
    }
}

fn mix(mut value: u32) -> u32 {
    value ^= value >> 16;
    value = value.wrapping_mul(0x85ebca6b);
    value ^= value >> 13;
    value = value.wrapping_mul(0xc2b2ae35);
    value ^ (value >> 16)
}

fn decode_sources(encoded: &str, seed: &str, media_id: u32) -> Result<Value, ResolveError> {
    if encoded.len() > MAX_METADATA_BYTES || seed.len() > 256 {
        return Err(ResolveError::Upstream);
    }
    let mut bytes = URL_SAFE_NO_PAD
        .decode(encoded.trim().trim_end_matches('='))
        .map_err(|_| ResolveError::Upstream)?;
    let hash = seed.encode_utf16().fold(0x811c9dc5u32, |hash, byte| {
        (hash ^ u32::from(byte)).wrapping_mul(0x01000193)
    });
    let mut state = mix(mix(hash) ^ mix(media_id ^ 0x9e3779b9));
    let mut slots = [None; 61];
    for index in 0..8 {
        let slot = (state % 61) as usize;
        state = state.wrapping_add(0x9e3779b9).rotate_left(7 + index);
        slots[slot] = Some(state ^ mix(state));
        state = mix(state.wrapping_add(slot as u32));
    }
    let mut accumulator = mix(0xa5a5a5a5 ^ state);
    for (index, chunk) in bytes.chunks_mut(4).enumerate() {
        let slot = (accumulator % 61) as usize;
        let word = slots[slot].unwrap_or(0) ^ 0x9e3779b9u32.wrapping_mul(index as u32 + 1);
        let mask = if slots[slot].is_some() { u32::MAX } else { 0 };
        let combined = (accumulator ^ word) | (accumulator & word & mask);
        accumulator = mix((combined.wrapping_add(accumulator).rotate_left(slot as u32)
            ^ accumulator.rotate_left(slot as u32 * 7))
        .wrapping_add(0x9e3779b9));
        slots[slot] = Some(accumulator);
        for (byte, key) in chunk.iter_mut().zip(accumulator.to_le_bytes()) {
            *byte ^= key;
        }
    }
    if !bytes.starts_with(b"mvm1") {
        return Err(ResolveError::Upstream);
    }
    serde_json::from_slice(&bytes[4..]).map_err(|_| ResolveError::Upstream)
}

async fn seed(client: &reqwest::Client, media_id: u32) -> Result<String, ResolveError> {
    if let Some((value, expiry)) = SEEDS.get(&media_id).await {
        if expiry > Instant::now() {
            return Ok(value);
        }
        SEEDS.invalidate(&media_id).await;
    }
    SEEDS
        .try_get_with(media_id, async {
            let _slot = LOOKUP_SLOTS.try_acquire().map_err(|_| ResolveError::Busy)?;
            let response = send_with_retry(|| {
                client
                    .get(format!("{API}/seed"))
                    .query(&[("mediaId", media_id)])
                    .headers(StreamProvider::Movy.headers())
                    .header("cache-control", "no-cache")
                    .timeout(REQUEST_TIMEOUT)
            })
            .await?;
            if !response.status().is_success() {
                return Err(ResolveError::Upstream);
            }
            let bytes = read_body_limited(response, 4096).await?;
            let payload: Value =
                serde_json::from_slice(&bytes).map_err(|_| ResolveError::Upstream)?;
            let value = payload
                .get("seed")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.len() <= 256)
                .ok_or(ResolveError::Upstream)?
                .to_string();
            let ttl = payload
                .get("ttlMs")
                .and_then(Value::as_u64)
                .unwrap_or(30_000)
                .saturating_sub(5000)
                .clamp(1, 25_000);
            Ok((value, Instant::now() + Duration::from_millis(ttl)))
        })
        .await
        .map(|(value, _)| value)
        .map_err(|error| *error)
}

fn expected_runtime(
    title: TitleKey,
    episode: i32,
    details: &Value,
    episode_details: Option<&Value>,
) -> Result<f64, ResolveError> {
    let name = match title.kind {
        TitleKind::Movie => "title",
        TitleKind::Tv => "name",
    };
    if details.get("id").and_then(number) != Some(title.tmdb_id)
        || details
            .get(name)
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
    {
        return Err(ResolveError::NotFound);
    }
    let runtime = match title.kind {
        TitleKind::Movie => {
            if episode != 1 {
                return Err(ResolveError::NotFound);
            }
            details.get("runtime")
        }
        TitleKind::Tv => {
            let episode_details = episode_details.ok_or(ResolveError::NotFound)?;
            if episode_details.get("season_number").and_then(number)
                != Some(u32::from(title.season))
                || episode_details.get("episode_number").and_then(number)
                    != u32::try_from(episode).ok().filter(|episode| *episode > 0)
                || episode_details
                    .get("id")
                    .and_then(number)
                    .is_none_or(|id| id == 0)
            {
                return Err(ResolveError::NotFound);
            }
            episode_details.get("runtime")
        }
    };
    runtime
        .and_then(number)
        .filter(|runtime| *runtime > 0)
        .map(|minutes| f64::from(minutes) * 60.0)
        .ok_or(ResolveError::NotFound)
}

fn runtime_matches(playlist: &str, expected: f64) -> bool {
    if !expected.is_finite() || expected <= 0.0 || is_master_playlist(playlist) {
        return false;
    }
    let mut duration = 0.0;
    let mut complete = false;
    for line in playlist.lines().map(str::trim) {
        if line == "#EXT-X-ENDLIST" {
            complete = true;
        }
        if let Some(value) = line.strip_prefix("#EXTINF:") {
            let Ok(seconds) = value.split(',').next().unwrap_or_default().parse::<f64>() else {
                return false;
            };
            if !seconds.is_finite() || seconds <= 0.0 {
                return false;
            }
            duration += seconds;
        }
    }
    complete
        && duration > 0.0
        && (duration - expected).abs() <= (expected * 0.15).clamp(90.0, 900.0)
}

async fn check_runtime(
    client: &reqwest::Client,
    source: &ResolvedSource,
    expected: f64,
) -> Result<Arc<String>, ResolveError> {
    if !is_master_playlist(&source.master) {
        return runtime_matches(&source.master, expected)
            .then(|| source.master.clone())
            .ok_or(ResolveError::NotFound);
    }
    let variants = hls_variant_references(&source.playlist_url, &source.master);
    if variants.len() > 32 {
        return Err(ResolveError::NotFound);
    }
    let mut available = vec![false; variants.len()];
    let mut checks = futures_util::stream::iter(variants.into_iter().enumerate().map(
        |(index, url)| async move {
            let valid = tokio::time::timeout(QUALITY_CHECK_TIMEOUT, async {
                fetch_playlist(client, &url, StreamProvider::Movy)
                    .await
                    .is_ok_and(|playlist| runtime_matches(&playlist, expected))
            })
            .await
            .unwrap_or(false);
            (index, valid)
        },
    ))
    .buffer_unordered(4);
    while let Some((index, valid)) = checks.next().await {
        available[index] = valid;
    }
    filter_variants(&source.master, &available).map(Arc::new)
}

fn source_params(
    title: TitleKey,
    episode: i32,
    details: &Value,
    server: &str,
) -> Result<Vec<(&'static str, String)>, ResolveError> {
    if details.get("id").and_then(number) != Some(title.tmdb_id) {
        return Err(ResolveError::NotFound);
    }
    let name = details
        .get(if title.kind == TitleKind::Movie { "title" } else { "name" })
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or(ResolveError::NotFound)?;
    let year = details
        .get(if title.kind == TitleKind::Movie { "release_date" } else { "first_air_date" })
        .and_then(Value::as_str)
        .and_then(|date| date.get(..4))
        .unwrap_or_default();
    let mut params = vec![
        ("title", urlencoding::encode(name).into_owned()),
        ("mediaType", title.kind.id().to_string()),
        ("year", year.to_string()),
        (
            "episodeId",
            if title.kind == TitleKind::Movie {
                1
            } else {
                episode
            }
            .to_string(),
        ),
        (
            "seasonId",
            if title.kind == TitleKind::Movie {
                1
            } else {
                title.season
            }
            .to_string(),
        ),
        ("tmdbId", title.tmdb_id.to_string()),
    ];
    if let Some(imdb) = details.get("imdb_id").and_then(Value::as_str).or_else(|| {
        details
            .pointer("/external_ids/imdb_id")
            .and_then(Value::as_str)
    }) {
        params.push(("imdbId", imdb.to_string()));
    }
    if let Some(seasons) = details.get("number_of_seasons").and_then(number) {
        params.push(("totalSeasons", seasons.to_string()));
    }
    let alternate = if server == "berlin" {
        details
            .pointer("/translations/translations")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|entry| entry.get("iso_639_1").and_then(Value::as_str) == Some("de"))
            .and_then(|entry| {
                entry
                    .pointer("/data/title")
                    .or_else(|| entry.pointer("/data/name"))
            })
    } else if matches!(server, "chicago" | "nashville") {
        details
            .get("original_title")
            .or_else(|| details.get("original_name"))
    } else {
        None
    };
    if let Some(alternate) = alternate
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && *value != name)
    {
        params.push(("altTitle", urlencoding::encode(alternate).into_owned()));
    }
    if server == "munich" {
        params.push(("language", "german".into()));
    }
    Ok(params)
}

async fn server_response(
    client: &reqwest::Client,
    title: TitleKey,
    episode: i32,
    details: &Value,
    server: &'static str,
) -> Result<Arc<Value>, ResolveError> {
    RESPONSES
        .try_get_with((title, episode, server), async {
            let params = source_params(title, episode, details, server)?;
            for attempt in 0..2 {
                let seed = seed(client, title.tmdb_id).await?;
                let _slot = LOOKUP_SLOTS.try_acquire().map_err(|_| ResolveError::Busy)?;
                let response = send_with_retry(|| {
                    client
                        .get(format!("{API}/{server}/sources"))
                        .query(&params)
                        .query(&[("enc", "2"), ("seed", seed.as_str())])
                        .headers(StreamProvider::Movy.headers())
                        .timeout(Duration::from_secs(6))
                })
                .await?;
                if response.status() == StatusCode::UNAUTHORIZED && attempt == 0 {
                    if SEEDS
                        .get(&title.tmdb_id)
                        .await
                        .is_some_and(|(current, _)| current == seed)
                    {
                        SEEDS.invalidate(&title.tmdb_id).await;
                    }
                    continue;
                }
                if response.status() == StatusCode::NOT_FOUND {
                    return Err(ResolveError::NotFound);
                }
                if !response.status().is_success() {
                    return Err(ResolveError::Upstream);
                }
                let bytes = read_body_limited(response, MAX_METADATA_BYTES).await?;
                let encoded = std::str::from_utf8(&bytes).map_err(|_| ResolveError::Upstream)?;
                return decode_sources(encoded, &seed, title.tmdb_id).map(Arc::new);
            }
            Err(ResolveError::Upstream)
        })
        .await
        .map_err(|error| *error)
}

fn candidates(payload: &Value, language: &str, server: &str) -> Vec<titles::Candidate> {
    let mut candidates = Vec::new();
    if let Some(url) = payload
        .get("playlist")
        .and_then(Value::as_str)
        .and_then(media_url)
    {
        candidates.push(titles::Candidate {
            url,
            language: language.into(),
            height: None,
            server: Some(server.into()),
        });
    }
    for source in payload
        .get("sources")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(32)
    {
        let Some(url) = source
            .get("url")
            .and_then(Value::as_str)
            .and_then(media_url)
        else {
            continue;
        };
        let label = source
            .get("quality")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if (server == "austin" && label != "English") || (server == "delhi" && label != "Hindi") {
            continue;
        }
        let explicit = titles::source_language(source);
        let language = if explicit == "und" {
            language
        } else {
            &explicit
        };
        if !candidates.iter().any(|candidate| candidate.url == url) {
            candidates.push(titles::Candidate {
                url,
                language: language.into(),
                height: titles::label_height(label).or_else(|| {
                    label
                        .parse::<u32>()
                        .ok()
                        .filter(|height| (144..=4320).contains(height))
                }),
                server: Some(server.into()),
            });
        }
    }
    candidates
}

fn media_url(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    if !parsed.path().ends_with(".m3u8") {
        return None;
    }
    titles::source_url(value)
}

fn server_order(requested: &str, original: &str) -> Vec<(&'static str, &'static str)> {
    let mut servers = SERVERS.to_vec();
    servers.retain(|(_, language)| *language == "original" || *language == requested);
    servers.sort_by_key(|(_, language)| {
        u8::from(if *language == "original" {
            original != requested
        } else {
            *language != requested
        })
    });
    servers
}

async fn resolve_server(
    client: &reqwest::Client,
    key: &EpisodeKey,
    identity: (TitleKey, i32),
    details: &Value,
    runtime: f64,
    additional: &[SubtitleTrack],
    server: (&'static str, &'static str),
) -> Result<ResolvedSource, ResolveError> {
    let (title, episode) = identity;
    let payload = server_response(client, title, episode, details, server.0).await?;
    let original = details
        .get("original_language")
        .and_then(Value::as_str)
        .unwrap_or("und");
    let declared = if server.1 == "original" {
        original
    } else {
        server.1
    };
    let candidates = candidates(&payload, declared, server.0);
    let mut tracks = titles::tracks(&[&payload]);
    for track in additional {
        if tracks.len() < 80 && !tracks.iter().any(|existing| existing.url == track.url) {
            tracks.push(track.clone());
        }
    }
    let mut mapped_key = key.clone();
    mapped_key.episode = episode;
    mapped_key.language = if key.title.is_none() {
        if key.language == "sub" { "ja" } else { "en" }.into()
    } else {
        key.language.clone()
    };
    let mut plans = titles::plan(&candidates, &mapped_key, title, &tracks);
    plans.sort_by_key(|source| {
        (
            !source.master.is_empty(),
            std::cmp::Reverse(
                parse_hls_qualities(&source.master)
                    .iter()
                    .map(|(_, _, height, _, _)| *height)
                    .max()
                    .unwrap_or(0),
            ),
        )
    });
    let mut failure = ResolveError::NotFound;
    for mut source in plans.into_iter().take(4) {
        source.provider = StreamProvider::Movy;
        let playlist =
            match fetch_playlist(client, &source.playlist_url, StreamProvider::Movy).await {
                Ok(playlist) => playlist,
                Err(error) => {
                    failure = error;
                    continue;
                }
            };
        if is_master_playlist(&playlist) || source.master.is_empty() {
            source.master = playlist;
        }
        source.master = match check_runtime(client, &source, runtime).await {
            Ok(master) => master,
            Err(error) => {
                failure = error;
                continue;
            }
        };
        let actual = source_language(
            client,
            &source.playlist_url,
            &source.master,
            &mapped_key.language,
        )
        .await;
        let language = actual
            .as_deref()
            .filter(|language| *language != "und")
            .or(source.language.as_deref());
        if !requested_language(key, language) {
            continue;
        }
        if key.title.is_none()
            && key.language == "sub"
            && !tracks.iter().any(|track| track.language == "en")
            && !source
                .master
                .lines()
                .filter_map(|line| line.strip_prefix("#EXT-X-MEDIA:"))
                .any(|attributes| {
                    let attributes = hls_attribute_list(attributes);
                    hls_attribute(&attributes, "TYPE") == Some("SUBTITLES")
                        && hls_attribute(&attributes, "LANGUAGE")
                            .is_some_and(|language| titles::language_code(language) == "en")
                })
        {
            continue;
        }
        source.language = Some(if key.title.is_none() {
            key.language.clone()
        } else {
            language.unwrap_or("und").to_string()
        });
        source.metadata.languages = SERVERS
            .iter()
            .map(|(_, language)| {
                if *language == "original" {
                    original.to_string()
                } else {
                    language.to_string()
                }
            })
            .collect();
        source.metadata.languages.sort();
        source.metadata.languages.dedup();
        source
            .metadata
            .languages
            .retain(|language| language != "und");
        if key.title.is_none() {
            source.metadata.languages = vec![key.language.clone()];
        }
        match prepare_source(client, source).await {
            Ok(source) => return Ok(source),
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

pub(super) async fn resolve(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<ResolvedSource, ResolveError> {
    let resolution_deadline =
        tokio::time::Instant::now() + resolution_budget(key) - Duration::from_millis(100);
    let (title, episode) = identity(client, key).await?;
    let (details, episode_details, additional) = tokio::join!(
        lookup(
            client,
            format!(
                "{METADATA}/3/{}/{}?append_to_response=external_ids,translations",
                title.kind.id(),
                title.tmdb_id
            )
        ),
        async {
            if title.kind == TitleKind::Tv {
                lookup(client, format!("{METADATA}/3/tv/{}/season/{}/episode/{episode}", title.tmdb_id, title.season))
                    .await
                    .map(Some)
            } else {
                Ok(None)
            }
        },
        tracks(client, title, episode)
    );
    let details = details?;
    let episode_details = episode_details?;
    let runtime = expected_runtime(title, episode, &details, episode_details.as_deref())?;
    let original = details
        .get("original_language")
        .and_then(Value::as_str)
        .unwrap_or("und");
    let requested = if key.title.is_none() {
        if key.language == "sub" {
            "ja"
        } else {
            "en"
        }
    } else {
        key.language.split('-').next().unwrap_or("en")
    };
    let mut attempts = Vec::<
        std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<ResolvedSource, ResolveError>> + Send + '_>,
        >,
    >::new();
    for server in server_order(requested, original) {
        if FAILED_SERVERS.get(&(title, episode, server.0)).await.is_some() {
            continue;
        }
        let details = &details;
        let additional = &additional;
        attempts.push(Box::pin(async move {
            tokio::time::timeout(
                Duration::from_secs(9),
                resolve_server(client, key, (title, episode), details, runtime, additional, server),
            )
            .await
            .unwrap_or(Err(ResolveError::Upstream))
        }));
    }
    let pending = futures_util::stream::iter(attempts).buffer_unordered(3);
    futures_util::pin_mut!(pending);
    let mut best: Option<ResolvedSource> = None;
    let mut deadline =
        resolution_deadline.min(tokio::time::Instant::now() + Duration::from_secs(12));
    let mut failure = ResolveError::NotFound;
    while let Ok(Some(result)) = tokio::time::timeout_at(deadline, pending.next()).await {
        match result {
            Ok(source) => {
                let height = |source: &ResolvedSource| {
                    parse_hls_qualities(&source.master)
                        .iter()
                        .map(|(_, _, height, _, _)| *height)
                        .max()
                        .unwrap_or(0)
                };
                if best
                    .as_ref()
                    .is_none_or(|previous| height(&source) > height(previous))
                {
                    best = Some(source);
                }
                let grace = if best.as_ref().is_some_and(has_4k) {
                    500
                } else {
                    1500
                };
                deadline = deadline.min(tokio::time::Instant::now() + Duration::from_millis(grace));
            }
            Err(ResolveError::RateLimited) => return best.ok_or(ResolveError::RateLimited),
            Err(error) => failure = error,
        }
    }
    best.ok_or(failure)
}

pub(super) async fn reject(key: &EpisodeKey, source: &ResolvedSource) {
    let Some(server) = SERVERS.iter().find_map(|(server, _)| {
        (source.metadata.server.as_deref() == Some(*server)).then_some(*server)
    }) else {
        return;
    };
    let identity = match key.title {
        Some(title) => Some((title, key.episode)),
        None => IDENTITIES.get(&(key.anilist_id, key.mal_id, key.episode)).await,
    };
    if let Some((title, episode)) = identity {
        FAILED_SERVERS.insert((title, episode, server), ()).await;
    }
}

pub(super) async fn invalidate(key: &EpisodeKey) {
    let identity = match key.title {
        Some(title) => Some((title, key.episode)),
        None => {
            IDENTITIES
                .get(&(key.anilist_id, key.mal_id, key.episode))
                .await
        }
    };
    if let Some((title, episode)) = identity {
        let _ = RESPONSES.invalidate_entries_if(move |(entry, number, _), _| {
            *entry == title && *number == episode
        });
    }
}

pub(super) async fn reclaim_caches() {
    LOOKUPS.invalidate_all();
    IDENTITIES.invalidate_all();
    RESPONSES.invalidate_all();
    FAILED_SERVERS.invalidate_all();
    SEEDS.invalidate_all();
    tokio::join!(
        LOOKUPS.run_pending_tasks(),
        IDENTITIES.run_pending_tasks(),
        RESPONSES.run_pending_tasks(),
        FAILED_SERVERS.run_pending_tasks(),
        SEEDS.run_pending_tasks()
    );
}

