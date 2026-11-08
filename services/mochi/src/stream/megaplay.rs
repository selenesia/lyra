use super::*;

pub(super) fn data_id(html: &str) -> Option<&str> {
    let marker = "data-id=\"";
    let start = html.find(marker)? + marker.len();
    let value = html.get(start..)?.split('"').next()?;
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
}

pub(super) fn data_realid(html: &str) -> Option<&str> {
    let marker = "data-realid=\"";
    let start = html.find(marker)? + marker.len();
    let value = html.get(start..)?.split('\"').next()?;
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())).then_some(value)
}

pub(super) fn embed_language(html: &str) -> Option<String> {
    [
        "window.settings",
        "const settings",
        "let settings",
        "var settings",
    ]
    .into_iter()
    .find_map(|declaration| {
        let (_, value) = html.split_once(declaration)?;
        let settings = value.trim_start().strip_prefix('=')?.trim_start();
        let (settings, _) = settings.strip_prefix('{')?.split_once('}')?;
        settings.split(',').find_map(|property| {
            let (key, value) = property.split_once(':')?;
            if key.trim().trim_matches(['\'', '"']) != "type" {
                return None;
            }
            let value = value.trim();
            let quote = value.chars().next()?;
            if quote != '\'' && quote != '"' {
                return None;
            }
            let language = value.strip_prefix(quote)?.strip_suffix(quote)?.trim();
            matches!(language, "sub" | "dub").then(|| language.to_string())
        })
    })
}

pub(super) fn source_urls(internal_id: &str) -> Vec<String> {
    vec![
        format!("{MEGAPLAY_BASE}/stream/getSourcesNew?id={internal_id}"),
        format!("{MEGAPLAY_BASE}/stream/getSources?id={internal_id}"),
    ]
}

pub(super) fn json_number(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|value| value.trim().parse().ok()))
        .filter(|value: &f64| value.is_finite())
}

pub(super) fn source_field<'a>(
    payload: &'a serde_json::Value,
    name: &str,
) -> Option<&'a serde_json::Value> {
    payload.get(name).or_else(|| {
        payload.get("sources").and_then(|sources| {
            sources
                .as_object()
                .and_then(|sources| sources.get(name))
                .or_else(|| sources.as_array()?.first()?.get(name))
        })
    })
}

pub(super) fn source_file_url(payload: &serde_json::Value) -> Option<String> {
    let sources = payload.get("sources");
    let candidates = [
        payload.get("file"),
        sources.and_then(|sources| sources.get("file")),
        sources.and_then(|sources| sources.as_array()?.first()?.get("file")),
    ];
    candidates
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::trim)
        .find(|url| url.starts_with("https://") && url.contains(".m3u8"))
        .map(str::to_string)
}

pub(super) fn megaplay_source_url(
    payload: &serde_json::Value,
) -> Result<Option<String>, ResolveError> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use base64::Engine;

    if let Some(url) = source_file_url(payload) {
        return Ok(Some(url));
    }
    let Some(token) = payload.get("enc") else {
        return Ok(None);
    };
    let token = token.as_str().ok_or(ResolveError::Upstream)?;
    let mut bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.trim_end_matches('='))
        .map_err(|_| ResolveError::Upstream)?;
    let mut key = [0u8; 32];
    let public_key = b"i?LMTAx0Q6,:}50U";
    key[..public_key.len()].copy_from_slice(public_key);
    let plaintext = cbc::Decryptor::<aes::Aes256>::new(&key.into(), b"W0;27ToaUpl_P%'c".into())
        .decrypt_padded_mut::<Pkcs7>(&mut bytes)
        .map_err(|_| ResolveError::Upstream)?;
    let decoded: serde_json::Value =
        serde_json::from_slice(plaintext).map_err(|_| ResolveError::Upstream)?;
    source_file_url(&decoded)
        .map(Some)
        .ok_or(ResolveError::Upstream)
}

pub(super) fn megaplay_playlist_url(source: &str, now: u64) -> Result<String, ResolveError> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use hmac::{Hmac, Mac};

    let mut url = Url::parse(source).map_err(|_| ResolveError::Upstream)?;
    if url.query_pairs().any(|(key, _)| key == "token") {
        return Ok(source.to_string());
    }
    let segments: Vec<_> = url.path_segments().into_iter().flatten().collect();
    let Some(pair) = segments.windows(2).find(|pair| {
        pair.iter()
            .all(|part| part.len() == 32 && part.bytes().all(|byte| byte.is_ascii_hexdigit()))
    }) else {
        return Ok(source.to_string());
    };
    let message = format!(
        "{}|{}/{}",
        now + 90,
        pair[0].to_ascii_lowercase(),
        pair[1].to_ascii_lowercase()
    );
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(b"MpCdnT0k3n!9f2K#xQ7vL5mR8wN1pY4s")
        .map_err(|_| ResolveError::Upstream)?;
    mac.update(message.as_bytes());
    let token = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(message),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    );
    url.query_pairs_mut().append_pair("token", &token);
    Ok(url.into())
}

pub(super) fn source_marker(value: Option<&serde_json::Value>) -> Option<TimeMarker> {
    let value = value?;
    let (start, end) = if let Some(object) = value.as_object() {
        (object.get("start"), object.get("end"))
    } else if let Some(values) = value.as_array() {
        (values.first(), values.get(1))
    } else {
        (None, None)
    };
    let start = json_number(start?)?;
    let end = json_number(end?)?;
    (start >= 0.0 && end > start).then_some(TimeMarker { start, end })
}

pub(super) fn source_label(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    if let Some(label) = value.as_str() {
        let label = label.trim();
        return (!label.is_empty()).then(|| label.to_string());
    }
    value.as_i64().map(|value| value.to_string())
}

pub(super) fn source_metadata(payload: &serde_json::Value) -> SourceMetadata {
    SourceMetadata {
        duration: source_field(payload, "duration")
            .and_then(json_number)
            .filter(|duration| *duration > 0.0),
        intro: source_marker(source_field(payload, "intro")),
        outro: source_marker(source_field(payload, "outro")),
        server: source_label(source_field(payload, "server")),
        languages: Vec::new(),
    }
}

pub(super) fn track_language(track: &serde_json::Value) -> String {
    let language_code = ["language", "lang", "srclang"]
        .iter()
        .filter_map(|key| track.get(*key).and_then(serde_json::Value::as_str))
        .map(str::trim)
        .find(|value| {
            !value.is_empty()
                && !matches!(value.to_ascii_lowercase().as_str(), "und" | "mul" | "zxx")
        })
        .unwrap_or_default()
        .to_ascii_lowercase()
        .replace('_', "-");
    if is_bcp47_language_tag(&language_code) {
        let (primary, region) = language_code
            .split_once('-')
            .unwrap_or((&language_code, ""));
        let primary = match primary {
            "eng" => "en",
            "jpn" => "ja",
            "spa" => "es",
            "fra" | "fre" => "fr",
            "deu" | "ger" => "de",
            "por" => "pt",
            "zho" | "chi" => "zh",
            "kor" => "ko",
            "ara" => "ar",
            "rus" => "ru",
            "ita" => "it",
            "ind" => "id",
            "tha" => "th",
            "vie" => "vi",
            "tur" => "tr",
            "msa" | "may" => "ms",
            "nld" | "dut" => "nl",
            "hin" => "hi",
            "pol" => "pl",
            value => value,
        };
        return if region.is_empty() {
            primary.to_string()
        } else {
            format!("{primary}-{region}")
        };
    }
    let label = track
        .get("label")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("und")
        .to_ascii_lowercase();
    let descriptor = format!("{language_code} {label}");
    let words = descriptor
        .split(|ch: char| !ch.is_alphanumeric())
        .collect::<Vec<_>>();
    let has = |name| words.contains(&name);
    match descriptor.as_str() {
        _ if has("english") || has("eng") || has("en") => "en",
        _ if has("indonesian") => "id",
        _ if has("thai") => "th",
        _ if has("spanish") || has("español") => "es",
        _ if has("french") || has("français") => "fr",
        _ if has("german") || has("deutsch") => "de",
        _ if has("portuguese") || has("português") => "pt",
        _ if has("japanese") || has("jpn") || has("日本語") => "ja",
        _ if has("arabic") || has("العربية") => "ar",
        value if value.contains("traditional") && value.contains("chinese") => "zh-hant",
        value if value.contains("simplified") && value.contains("chinese") => "zh-hans",
        value if value.contains("chinese") => "zh",
        _ if has("korean") || has("한국어") => "ko",
        _ if has("russian") || has("русский") => "ru",
        _ if has("italian") => "it",
        _ if has("turkish") => "tr",
        _ if has("vietnamese") => "vi",
        _ if has("malay") => "ms",
        _ if has("danish") => "da",
        _ if has("norwegian") => "no",
        _ if has("swedish") => "sv",
        _ if has("ukrainian") => "uk",
        _ if has("greek") => "el",
        _ => "und",
    }
    .to_string()
}

pub(super) fn subtitle_tracks(payload: &serde_json::Value) -> Vec<SubtitleTrack> {
    let mut tracks = Vec::<SubtitleTrack>::new();
    for track in source_field(payload, "tracks")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(file) = track
            .get("file")
            .or_else(|| track.get("src"))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Ok(url) = Url::parse(file.trim()) else {
            continue;
        };
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            continue;
        }
        let kind = track
            .get("kind")
            .or_else(|| track.get("type"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let kind = match kind.as_str() {
            "" | "subtitle" | "subtitles" | "vtt" | "srt" | "ass" | "ssa" => "subtitles",
            "captions" => "captions",
            _ => continue,
        };
        if tracks.iter().any(|track| track.url == url.as_str()) {
            continue;
        }
        let flag = |name| {
            track.get(name).is_some_and(|value| {
                value.as_bool() == Some(true)
                    || value.as_str().is_some_and(|value| {
                        matches!(value.to_ascii_lowercase().as_str(), "true" | "yes" | "1")
                    })
            })
        };
        tracks.push(SubtitleTrack {
            url: url.to_string(),
            label: source_label(track.get("label")).unwrap_or_default(),
            language: track_language(track),
            kind: kind.to_string(),
            default: flag("default"),
            forced: flag("forced"),
        });
    }
    tracks
}

pub(super) fn is_bcp47_language_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let Some(primary) = parts.next() else {
        return false;
    };
    if !(2..=3).contains(&primary.len()) || !primary.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return false;
    }
    parts.all(|part| {
        !part.is_empty() && part.len() <= 8 && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
    })
}

pub(super) fn embed_urls(key: &EpisodeKey) -> Vec<String> {
    let mut urls = Vec::with_capacity(3);
    if !key.anikoto_episode_id.is_empty() {
        urls.push(format!(
            "{MEGAPLAY_BASE}/stream/s-2/{}/{}",
            key.anikoto_episode_id, key.language
        ));
    }
    if key.anilist_id > 0 {
        urls.push(format!(
            "{MEGAPLAY_BASE}/stream/ani/{}/{}/{}",
            key.anilist_id, key.episode, key.language
        ));
    }
    if key.mal_id > 0 {
        urls.push(format!(
            "{MEGAPLAY_BASE}/stream/mal/{}/{}/{}",
            key.mal_id, key.episode, key.language
        ));
    }
    urls
}

pub(super) async fn resolve_megaplay(
    client: &reqwest::Client,
    key: &EpisodeKey,
) -> Result<ResolvedSource, ResolveError> {
    let mut saw_upstream_error = false;
    for embed_url in embed_urls(key) {
        let response = match send_with_retry(|| {
            client
                .get(&embed_url)
                .header(ACCEPT, "text/html,application/xhtml+xml")
                .header(REFERER, MEGAPLAY_REFERER)
                .header("Sec-Fetch-Dest", "iframe")
                .header("Sec-Fetch-Mode", "navigate")
                .header("Sec-Fetch-Site", "same-origin")
        })
        .await
        {
            Ok(response) => response,
            Err(_) => {
                saw_upstream_error = true;
                continue;
            }
        };
        if !response.status().is_success() {
            continue;
        }
        let body = match read_body_limited(response, MAX_METADATA_BYTES).await {
            Ok(body) => body,
            Err(_) => {
                saw_upstream_error = true;
                continue;
            }
        };
        let html = match String::from_utf8(body.to_vec()) {
            Ok(html) => html,
            Err(_) => {
                saw_upstream_error = true;
                continue;
            }
        };
        let Some(internal_id) = data_id(&html).or_else(|| data_realid(&html)) else {
            continue;
        };
        let embed_language = embed_language(&html);
        if let Some(actual_language) = embed_language.as_deref() {
            if actual_language != key.language {
                continue;
            }
        }
        for sources_url in source_urls(internal_id) {
            let response = match send_with_retry(|| {
                client
                    .get(&sources_url)
                    .header(ACCEPT, "application/json, text/plain, */*")
                    .header(REFERER, &embed_url)
                    .header("Origin", MEGAPLAY_BASE)
                    .header("X-Requested-With", "XMLHttpRequest")
            })
            .await
            {
                Ok(response) => response,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            if !response.status().is_success() {
                continue;
            }
            let source_body = match read_body_limited(response, MAX_METADATA_BYTES).await {
                Ok(body) => body,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            let payload: serde_json::Value = match serde_json::from_slice(&source_body) {
                Ok(payload) => payload,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            let playlist_url = match megaplay_source_url(&payload) {
                Ok(url) => url,
                Err(_) => {
                    saw_upstream_error = true;
                    continue;
                }
            };
            let Some(playlist_url) = playlist_url else {
                continue;
            };
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| ResolveError::Upstream)?
                .as_secs();
            let playlist_url = megaplay_playlist_url(&playlist_url, now)?;
            if FAILED_SOURCES.get(&playlist_url).await.is_some() {
                continue;
            }
            let metadata = source_metadata(&payload);
            let tracks = subtitle_tracks(&payload);
            return Ok(ResolvedSource {
                provider: StreamProvider::Megaplay,
                playlist_url,
                fallback_playlist_url: None,
                master: Arc::new(String::new()),
                tracks,
                internal_id: internal_id.to_string(),
                generation: 0,
                language: embed_language.clone(),
                metadata,
            });
        }
    }
    if saw_upstream_error {
        Err(ResolveError::Upstream)
    } else {
        Err(ResolveError::NotFound)
    }
}
