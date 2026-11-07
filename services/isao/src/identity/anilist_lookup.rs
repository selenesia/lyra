use super::*;

#[derive(Debug, Deserialize)]
pub(super) struct AniListEnvelope {
    data: Option<AniListData>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AniListData {
    #[serde(rename = "Media")]
    media: Option<AniListMedia>,
    #[serde(rename = "Page")]
    page: Option<AniListPage>,
}

#[derive(Debug, Deserialize)]
pub(super) struct AniListPage {
    media: Option<Vec<AniListMedia>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct AniListMedia {
    id: i64,
    #[serde(rename = "idMal")]
    id_mal: Option<i64>,
    title: Option<TitleSet>,
    synonyms: Option<Vec<String>>,
    pub(super) format: Option<String>,
    season: Option<String>,
    #[serde(rename = "seasonYear")]
    pub(super) season_year: Option<i32>,
    episodes: Option<i32>,
    #[serde(rename = "startDate")]
    start_date: Option<DateSet>,
    #[serde(rename = "externalLinks")]
    external_links: Option<Vec<ExternalLink>>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct TitleSet {
    romaji: Option<String>,
    english: Option<String>,
    native: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct DateSet {
    year: Option<i32>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct ExternalLink {
    site: Option<String>,
    url: Option<String>,
}

pub(super) async fn anilist_request(
    client: &reqwest::Client,
    query: &str,
    variables: Value,
) -> Option<AniListEnvelope> {
    crate::anilist::wait_for_slot().await;
    for attempt in 0..3 {
        let response = client
            .post(ANILIST_URL)
            .header(USER_AGENT, IDENTITY_USER_AGENT)
            .header("Content-Type", "application/json")
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await
            .ok()?;
        if response.status().as_u16() == 429 || response.status().is_server_error() {
            tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await;
            continue;
        }
        if !response.status().is_success() {
            return None;
        }
        return response.json().await.ok();
    }
    None
}

pub(super) async fn fetch_anilist(client: &reqwest::Client, id: &str) -> Option<AniListMedia> {
    let id = id.parse::<i64>().ok()?;
    let query = r#"
      query($id:Int) {
        Media(id:$id, type:ANIME) {
          id idMal title { romaji english native } synonyms format season seasonYear episodes
          startDate { year }
          externalLinks { site url }
        }
      }
    "#;
    anilist_request(client, query, json!({ "id": id }))
        .await
        .and_then(|response| response.data?.media)
}

pub(super) async fn search_anilist(client: &reqwest::Client, title: &str) -> Vec<AniListMedia> {
    let query = r#"
      query($search:String) {
        Page(perPage:10) {
          media(search:$search, type:ANIME) {
            id idMal title { romaji english native } synonyms format season seasonYear episodes
            startDate { year }
            externalLinks { site url }
          }
        }
      }
    "#;
    anilist_request(client, query, json!({ "search": title }))
        .await
        .and_then(|response| response.data?.page?.media)
        .unwrap_or_default()
}

pub(super) fn media_titles(media: &AniListMedia) -> Vec<String> {
    let mut titles = Vec::new();
    if let Some(title) = &media.title {
        if let Some(value) = &title.romaji {
            push_unique(&mut titles, value);
        }
        if let Some(value) = &title.english {
            push_unique(&mut titles, value);
        }
        if let Some(value) = &title.native {
            push_unique(&mut titles, value);
        }
    }
    for title in media.synonyms.as_deref().unwrap_or_default() {
        push_unique(&mut titles, title.as_str());
    }
    titles
}

pub(super) fn merge_anilist(identity: &mut AnimeIdentity, media: &AniListMedia, source: &str) {
    set_id_string(&mut identity.ids, "anilist", media.id.to_string());
    if let Some(mal) = media.id_mal {
        set_id_string(&mut identity.ids, "mal", mal.to_string());
    }
    for title in media_titles(media) {
        push_unique(&mut identity.titles, title);
    }
    identity.year = identity
        .year
        .or(media.season_year)
        .or_else(|| media.start_date.as_ref().and_then(|date| date.year));
    identity.season = identity.season.clone().or_else(|| media.season.clone());
    identity.format = identity.format.clone().or_else(|| media.format.clone());
    identity.episodes = identity.episodes.or(media.episodes);
    add_source(identity, source);
    for link in media.external_links.as_deref().unwrap_or_default() {
        if let (Some(site), Some(url)) = (link.site.as_deref(), link.url.as_deref()) {
            if let Some((provider, id)) = external_link_id(site, url) {
                set_id_string(&mut identity.ids, provider, id);
            }
        }
    }
}
