use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct KitsuObjectResponse {
    data: Option<KitsuResource>,
}

#[derive(Debug, Deserialize)]
pub(super) struct KitsuListResponse {
    data: Option<Vec<KitsuResource>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct KitsuResource {
    pub(super) id: String,
    attributes: Option<KitsuAttributes>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct KitsuAttributes {
    #[serde(rename = "canonicalTitle")]
    canonical_title: Option<String>,
    titles: Option<std::collections::HashMap<String, String>>,
    #[serde(rename = "startDate")]
    start_date: Option<String>,
    subtype: Option<String>,
    #[serde(rename = "episodeCount")]
    episode_count: Option<i32>,
    #[serde(rename = "externalSite")]
    external_site: Option<String>,
    #[serde(rename = "externalId")]
    external_id: Option<String>,
}

pub(super) async fn search_kitsu(client: &reqwest::Client, title: &str) -> Vec<KitsuResource> {
    let mut url = match Url::parse(&format!("{KITSU_BASE}/anime")) {
        Ok(url) => url,
        Err(_) => return Vec::new(),
    };
    url.query_pairs_mut()
        .append_pair("filter[text]", title)
        .append_pair("page[limit]", "20");
    get_json::<KitsuListResponse>(client, url.as_str())
        .await
        .and_then(|response| response.data)
        .unwrap_or_default()
}

pub(super) fn kitsu_resource_titles(resource: &KitsuResource) -> Vec<String> {
    let mut titles = Vec::new();
    if let Some(attributes) = &resource.attributes {
        if let Some(title) = &attributes.canonical_title {
            push_unique(&mut titles, title);
        }
        if let Some(values) = &attributes.titles {
            for title in values.values() {
                push_unique(&mut titles, title);
            }
        }
    }
    titles
}

pub(super) fn kitsu_title_matches(
    resource: &KitsuResource,
    requested_title: &str,
    requested_year: Option<i32>,
    requested_format: Option<&str>,
) -> bool {
    let Some(attributes) = &resource.attributes else {
        return false;
    };
    if !kitsu_resource_titles(resource)
        .iter()
        .any(|title| normalize_title(title) == normalize_title(requested_title))
    {
        return false;
    }
    if let (Some(expected), Some(actual)) = (
        requested_year,
        attributes
            .start_date
            .as_deref()
            .and_then(|date| date.get(0..4))
            .and_then(|year| year.parse::<i32>().ok()),
    ) {
        if expected != actual {
            return false;
        }
    }
    format_matches(requested_format, attributes.subtype.as_deref())
}

pub(super) fn kitsu_sites(ids: &AnimeIds) -> Vec<(&'static str, String)> {
    let mut values = Vec::new();
    if let Some(id) = &ids.anilist {
        values.push(("anilist/anime", id.clone()));
    }
    if let Some(id) = &ids.mal {
        values.push(("myanimelist/anime", id.clone()));
    }
    if let Some(id) = &ids.anidb {
        values.push(("anidb", id.clone()));
    }
    if let Some(id) = &ids.imdb {
        values.push(("imdb", id.clone()));
    }
    if let Some(id) = &ids.tvdb {
        values.push(("thetvdb/series", id.clone()));
    }
    if let Some(id) = &ids.tvdb_season {
        values.push(("thetvdb/season", id.clone()));
    }
    if let Some(id) = &ids.tmdb {
        values.push(("themoviedb/tv", id.clone()));
        values.push(("themoviedb/movie", id.clone()));
    }
    if let Some(id) = &ids.tmdb_season {
        values.push(("themoviedb/season", id.clone()));
    }
    if let Some(id) = &ids.anime_planet {
        values.push(("anime-planet/anime", id.clone()));
    }
    if let Some(id) = &ids.live_chart {
        values.push(("livechart", id.clone()));
    }
    if let Some(id) = &ids.ani_search {
        values.push(("anisearch", id.clone()));
    }
    if let Some(id) = &ids.anime_news_network {
        values.push(("animenewsnetwork", id.clone()));
    }
    values
}

pub(super) async fn fetch_kitsu_mappings(
    client: &reqwest::Client,
    kitsu_id: &str,
) -> Option<Vec<KitsuResource>> {
    let url = format!("{KITSU_BASE}/anime/{kitsu_id}/mappings");
    get_json::<KitsuListResponse>(client, &url)
        .await
        .and_then(|response| response.data)
}

pub(super) async fn fetch_kitsu_for_ids(
    client: &reqwest::Client,
    ids: &AnimeIds,
) -> Option<(KitsuResource, Vec<KitsuResource>)> {
    if let Some(kitsu_id) = &ids.kitsu {
        let mappings = fetch_kitsu_mappings(client, kitsu_id).await?;
        let anime_url = format!("{KITSU_BASE}/anime/{kitsu_id}");
        let anime = get_json::<KitsuObjectResponse>(client, &anime_url)
            .await
            .and_then(|response| response.data)
            .unwrap_or_else(|| KitsuResource {
                id: kitsu_id.clone(),
                attributes: None,
            });
        return Some((anime, mappings));
    }

    for (site, external_id) in kitsu_sites(ids) {
        let Ok(response) = client
            .get(format!("{KITSU_BASE}/mappings"))
            .query(&[
                ("filter[external_site]", site),
                ("filter[external_id]", external_id.as_str()),
            ])
            .header(USER_AGENT, IDENTITY_USER_AGENT)
            .send()
            .await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(mappings) = response.json::<KitsuListResponse>().await else {
            continue;
        };
        let Some(mapping) = mappings.data.and_then(|items| items.into_iter().next()) else {
            continue;
        };
        let mapping_id = mapping.id;
        let item_url = format!("{KITSU_BASE}/mappings/{mapping_id}/item");
        let Some(anime) = get_json::<KitsuObjectResponse>(client, &item_url)
            .await
            .and_then(|response| response.data)
        else {
            continue;
        };
        let Some(all_mappings) = fetch_kitsu_mappings(client, &anime.id).await else {
            continue;
        };
        return Some((anime, all_mappings));
    }
    None
}

pub(super) fn merge_kitsu(
    identity: &mut AnimeIdentity,
    anime: &KitsuResource,
    mappings: &[KitsuResource],
) {
    set_id_string(&mut identity.ids, "kitsu", anime.id.clone());
    if let Some(attributes) = &anime.attributes {
        if let Some(title) = &attributes.canonical_title {
            push_unique(&mut identity.titles, title);
        }
        if let Some(titles) = &attributes.titles {
            for title in titles.values() {
                push_unique(&mut identity.titles, title);
            }
        }
        identity.year = identity.year.or_else(|| {
            attributes
                .start_date
                .as_deref()
                .and_then(|date| date.get(0..4))
                .and_then(|year| year.parse().ok())
        });
        identity.format = identity
            .format
            .clone()
            .or_else(|| attributes.subtype.clone());
        identity.episodes = identity.episodes.or(attributes.episode_count);
    }
    for mapping in mappings {
        let Some(attributes) = &mapping.attributes else {
            continue;
        };
        let (Some(site), Some(external_id)) = (
            attributes.external_site.as_deref(),
            attributes.external_id.as_deref(),
        ) else {
            continue;
        };
        if let Some((provider, id)) = kitsu_mapping_id(site, external_id) {
            set_id_string(&mut identity.ids, provider, id);
        }
    }
    add_source(identity, "kitsu");
}

pub(super) fn kitsu_mapping_id(site: &str, external_id: &str) -> Option<(&'static str, String)> {
    let site = site.to_ascii_lowercase();
    let provider = match site.as_str() {
        "myanimelist/anime" => "mal",
        "anilist/anime" => "anilist",
        "anidb" => "anidb",
        "imdb" | "imdb/title" => "imdb",
        "thetvdb/series" | "thetvdb" => "tvdb",
        "thetvdb/season" => "tvdbSeason",
        "themoviedb/tv" | "themoviedb/movie" | "themoviedb" => "tmdb",
        "themoviedb/season" => "tmdbSeason",
        "anime-planet/anime" | "anime-planet" => "animePlanet",
        "livechart" | "livechart/me" => "liveChart",
        "animenewsnetwork" | "animenewsnetwork/encyclopedia" => "animeNewsNetwork",
        "anisearch" => "aniSearch",
        "simkl" => "simkl",
        "animecountdown" => "animeCountdown",
        _ => return None,
    };
    Some((provider, external_id.to_string()))
}
