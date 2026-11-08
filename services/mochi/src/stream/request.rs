use super::*;

pub(super) fn normalized_language(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "sub" => Some("sub"),
        "dub" => Some("dub"),
        _ => None,
    }
}

pub(super) fn normalized_title_language(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase();
    if value.is_empty() {
        return Some("en".into());
    }
    ((2..=3).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_lowercase()))
        .then_some(value)
}

fn parse_title_key(
    media_type: &str,
    tmdb_id: &str,
    season: Option<&str>,
    episode: &str,
) -> Result<(TitleKey, i32), ResolveError> {
    let kind = match media_type {
        "movie" => TitleKind::Movie,
        "tv" => TitleKind::Tv,
        _ => return Err(ResolveError::Invalid),
    };
    let digits = |value: &str, max_len: usize| {
        !value.is_empty() && value.len() <= max_len && value.bytes().all(|byte| byte.is_ascii_digit())
    };
    if !digits(tmdb_id, 10) {
        return Err(ResolveError::Invalid);
    }
    let tmdb_id = tmdb_id.parse::<u32>().map_err(|_| ResolveError::Invalid)?;
    if tmdb_id == 0 {
        return Err(ResolveError::Invalid);
    }
    if kind == TitleKind::Movie {
        if season.is_some_and(|season| !season.is_empty()) || !(episode.is_empty() || episode == "1") {
            return Err(ResolveError::Invalid);
        }
        return Ok((TitleKey { kind, tmdb_id, season: 0 }, 1));
    }
    let season = season.ok_or(ResolveError::Invalid)?;
    if !digits(season, 4) || !digits(episode, 5) {
        return Err(ResolveError::Invalid);
    }
    let season = season.parse::<u16>().map_err(|_| ResolveError::Invalid)?;
    let episode = episode.parse::<i32>().map_err(|_| ResolveError::Invalid)?;
    if episode <= 0 {
        return Err(ResolveError::Invalid);
    }
    Ok((TitleKey { kind, tmdb_id, season }, episode))
}

pub(super) fn parse_episode_key(uri: &Uri) -> Result<EpisodeKey, ResolveError> {
    let mut anilist_id = 0;
    let mut mal_id = 0;
    let mut anikoto_episode_id = String::new();
    let mut episode = 0;
    let mut episode_value = String::new();
    let mut language = None::<String>;
    let mut session = String::new();
    let mut prefer_4k = false;
    let mut auto_4k = false;
    let mut media_type = None::<String>;
    let mut tmdb_id = String::new();
    let mut season = None::<String>;
    let mut has_anime_id = false;
    let path_parts: Vec<_> = uri
        .path()
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    if path_parts.first() == Some(&"stream") && path_parts.get(1) == Some(&"s-2") {
        anikoto_episode_id = path_parts.get(2).copied().unwrap_or_default().to_string();
        has_anime_id = true;
        if let Some(path_language) = path_parts.get(3) {
            language = Some((*path_language).to_string());
        }
    }
    for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "anilist_id" => {
                has_anime_id = true;
                anilist_id = value.parse().unwrap_or(0)
            }
            "mal_id" => {
                has_anime_id = true;
                mal_id = value.parse().unwrap_or(0)
            }
            "anikoto_episode_id" => {
                has_anime_id = true;
                anikoto_episode_id = value.into_owned()
            }
            "episode" => {
                episode = value.parse().unwrap_or(0);
                episode_value = value.into_owned();
            }
            "language" => language = Some(value.into_owned()),
            "media_type" => media_type = Some(value.into_owned()),
            "tmdb_id" => tmdb_id = value.into_owned(),
            "season" => season = Some(value.into_owned()),
            "session" => session = value.into_owned(),
            "preferred_quality" => {
                prefer_4k = value == "2160p";
                auto_4k = value == "auto";
            }
            _ => {}
        }
    }
    if session.len() > 64
        || !session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(ResolveError::Invalid);
    }
    if let Some(media_type) = media_type {
        if has_anime_id {
            return Err(ResolveError::Invalid);
        }
        let (title, episode) = parse_title_key(&media_type, &tmdb_id, season.as_deref(), &episode_value)?;
        let language = normalized_title_language(language.as_deref().unwrap_or_default())
            .ok_or(ResolveError::Invalid)?;
        return Ok(EpisodeKey {
            anilist_id: 0,
            mal_id: 0,
            anikoto_episode_id: String::new(),
            title: Some(title),
            episode,
            language,
            session,
            prefer_4k,
            auto_4k,
        });
    }
    if !tmdb_id.is_empty() {
        return Err(ResolveError::Invalid);
    }
    let Some(language) = normalized_language(language.as_deref().unwrap_or("sub")) else {
        return Err(ResolveError::Invalid);
    };
    let valid_direct_id = !anikoto_episode_id.is_empty()
        && anikoto_episode_id.bytes().all(|byte| byte.is_ascii_digit());
    if !valid_direct_id && (episode <= 0 || (anilist_id <= 0 && mal_id <= 0)) {
        return Err(ResolveError::Invalid);
    }
    if valid_direct_id && episode <= 0 {
        episode = 1;
    }
    Ok(EpisodeKey {
        anilist_id,
        mal_id,
        anikoto_episode_id: if valid_direct_id {
            anikoto_episode_id
        } else {
            String::new()
        },
        title: None,
        episode,
        language: language.to_string(),
        session,
        prefer_4k,
        auto_4k,
    })
}

pub(super) fn query_value(uri: &Uri, name: &str) -> Option<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .find_map(|(key, value)| (key == name).then(|| value.into_owned()))
}

pub(super) fn received_anilist_ids(uri: &Uri) -> Vec<String> {
    url::form_urlencoded::parse(uri.query().unwrap_or_default().as_bytes())
        .filter(|(key, _)| key == "anilist_id")
        .map(|(_, value)| value.into_owned())
        .collect()
}

pub(super) fn stream_base_path(key: &EpisodeKey) -> &'static str {
    if key.title.is_some() {
        "/stream/watch"
    } else {
        "/stream/anikoto"
    }
}

pub(super) fn query_string(
    key: &EpisodeKey,
    anilist_ids: &[String],
    extra: &[(&str, String)],
) -> String {
    let mut query = url::form_urlencoded::Serializer::new(String::new());
    if let Some(title) = key.title {
        query.append_pair("media_type", title.kind.id());
        query.append_pair("tmdb_id", &title.tmdb_id.to_string());
        if title.kind == TitleKind::Tv {
            query.append_pair("season", &title.season.to_string());
        }
    } else if !anilist_ids.is_empty() {
        for anilist_id in anilist_ids {
            query.append_pair("anilist_id", anilist_id);
        }
    } else if key.anilist_id > 0 {
        query.append_pair("anilist_id", &key.anilist_id.to_string());
    }
    if key.mal_id > 0 {
        query.append_pair("mal_id", &key.mal_id.to_string());
    }
    if !key.anikoto_episode_id.is_empty() {
        query.append_pair("anikoto_episode_id", &key.anikoto_episode_id);
    }
    query.append_pair("episode", &key.episode.to_string());
    query.append_pair("language", &key.language);
    if key.prefer_4k {
        query.append_pair("preferred_quality", "2160p");
    } else if key.auto_4k {
        query.append_pair("preferred_quality", "auto");
    }
    if !key.session.is_empty() {
        query.append_pair("session", &key.session);
    }
    for (name, value) in extra {
        query.append_pair(name, value);
    }
    query.finish()
}

pub(super) fn requested_source_generation(uri: &Uri) -> Result<Option<u64>, ResolveError> {
    query_value(uri, "source_generation")
        .map(|value| value.parse::<u64>().map_err(|_| ResolveError::Invalid))
        .transpose()
}

pub(super) fn ensure_source_generation(
    source: &ResolvedSource,
    requested: Option<u64>,
) -> Result<(), ResolveError> {
    if requested.is_some_and(|generation| generation != source.generation) {
        return Err(ResolveError::Stale);
    }
    Ok(())
}

pub(super) fn source_generation(
    provider: StreamProvider,
    internal_id: &str,
    language: Option<&str>,
    playlist_url: &str,
    tracks: &[SubtitleTrack],
) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;

    let mut hash = FNV_OFFSET;
    for part in [
        provider.id(),
        internal_id,
        language.unwrap_or_default(),
        playlist_url,
    ]
    .into_iter()
    .chain(tracks.iter().flat_map(|track| {
        [
            track.url.as_str(),
            track.label.as_str(),
            track.language.as_str(),
            track.kind.as_str(),
            if track.default { "default" } else { "" },
            if track.forced { "forced" } else { "" },
        ]
    })) {
        for byte in part.bytes().chain(std::iter::once(0)) {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash.max(1)
}
