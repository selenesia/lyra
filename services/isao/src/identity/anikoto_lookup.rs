use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct AnikotoSeriesResponse {
    data: Option<AnikotoSeriesData>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AnikotoSeriesData {
    anime: Option<AnikotoAnime>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AnikotoAnime {
    title: Option<String>,
    alternative: Option<String>,
    titles: Option<String>,
    native: Option<String>,
    year: Option<i32>,
    season: Option<String>,
    episodes: Option<Value>,
    mal_id: Option<Value>,
    ani_id: Option<Value>,
    #[serde(rename = "terms_by_type")]
    terms_by_type: Option<std::collections::HashMap<String, Vec<String>>>,
}

pub(super) async fn fetch_anikoto_series(
    client: &reqwest::Client,
    anikoto_id: &str,
) -> Option<AnikotoAnime> {
    let url = format!("https://anikotoapi.site/series/{anikoto_id}");
    get_json::<AnikotoSeriesResponse>(client, &url)
        .await
        .and_then(|response| response.data)
        .and_then(|data| data.anime)
}

pub(super) fn merge_anikoto(identity: &mut AnimeIdentity, anikoto_id: &str, anime: &AnikotoAnime) {
    set_id_string(&mut identity.ids, "anikoto", anikoto_id.to_string());
    for title in [
        anime.title.as_deref(),
        anime.alternative.as_deref(),
        anime.titles.as_deref(),
        anime.native.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        push_unique(&mut identity.titles, title);
    }
    identity.year = identity.year.or(anime.year);
    identity.season = identity.season.clone().or_else(|| anime.season.clone());
    identity.episodes = identity
        .episodes
        .or_else(|| value_id(anime.episodes.as_ref()).and_then(|value| value.parse::<i32>().ok()));
    if identity.format.is_none() {
        identity.format = anime
            .terms_by_type
            .as_ref()
            .and_then(|terms| terms.get("type"))
            .and_then(|types| types.first())
            .cloned();
    }
    set_id(&mut identity.ids, "mal", anime.mal_id.as_ref());
    set_id(&mut identity.ids, "anilist", anime.ani_id.as_ref());
    add_source(identity, "anikoto");
}
