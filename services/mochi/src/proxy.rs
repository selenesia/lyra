use crate::cache::{
    disk_writer, get_cache_path, load_from_disk, request_bypasses_cache, stream_cache_fresh,
    write_cache_header, write_to_disk,
};
use crate::constants;
use crate::encoding::decode_mochi_url;
use crate::helpers::{
    fix_game_content_type, is_blacklisted_header, is_blacklisted_res_header,
    is_likely_static_asset_fast,
};
use crate::rewrite::{rewrite_css_urls, rewrite_html};
use crate::safe_dns::validate_public_target;
use crate::state::{AppState, CachedResponse};
use crate::websocket::{self, handle_socket};
use crate::{negative_message, NEGATIVE};
use axum::{
    body::Body,
    extract::{ws::WebSocketUpgrade, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use bytes::Bytes;
use dashmap::mapref::entry::Entry;
use futures_util::StreamExt;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, OnceLock,
};
use std::time::{Duration, SystemTime};
use tokio::fs::{self, File};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc};
use tokio::time::sleep;
use tokio_stream::wrappers::ReceiverStream;
use tracing::{debug, error, warn};
use url::Url;

mod fetch;
mod headers;
mod metrics;
mod raw;
mod upstream;

use fetch::*;
use headers::*;
use metrics::*;
use upstream::*;
pub(crate) use headers::{build_safe_response_headers, response_allows_shared_cache};
pub(crate) use metrics::metrics_handler;
pub(crate) use raw::raw_proxy_handler;
pub(crate) use upstream::{safe_to_retry, UpstreamBody};

static UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
static SEC_CH_UA: &str =
    "\"Not-A.Brand\";v=\"99\", \"Chromium\";v=\"124\", \"Google Chrome\";v=\"124\"";
static MOCHI_UPSTREAM_META_HEADER: &str = "x-mochi-upstream-meta";
const MAX_COVER_BODY_SIZE: usize = 5 * 1024 * 1024;
const MAX_UPSTREAM_ATTEMPTS: usize = 3;
const MAX_HTML_BODY_SIZE: usize = 16 * 1024 * 1024;
const MAX_CSS_BODY_SIZE: usize = 4 * 1024 * 1024;

fn decoded_target(raw: &str) -> Option<(String, Option<String>)> {
    if raw.starts_with("http://") || raw.starts_with("https://")
        || raw.starts_with("ws://") || raw.starts_with("wss://") || raw.starts_with("ws/")
    {
        return Some((raw.to_owned(), None));
    }
    for scheme in ["https:/", "http:/"] {
        if let Some(rest) = raw.strip_prefix(scheme) {
            return Some((format!("{scheme}/{rest}"), None));
        }
    }
    let (token, base, suffix) = token_relative(raw)?;
    let resolved = if suffix.is_empty() { base } else { base.join(suffix).ok()? };
    Some((resolved.to_string(), Some(token.to_owned())))
}

fn token_relative(raw: &str) -> Option<(&str, Url, &str)> {
    let end = raw.find(['/', '?']).unwrap_or(raw.len());
    let token = &raw[..end];
    let base = Url::parse(&decode_mochi_url(token)?).ok()?;
    let suffix = &raw[end..];
    let suffix = suffix.strip_prefix('/').unwrap_or(suffix);
    Some((token, base, suffix.strip_prefix("!a!").unwrap_or(suffix)))
}

async fn effective_base(state: &AppState, headers: &HeaderMap, base: Url) -> Url {
    if validate_public_target(&base).is_err() {
        return base;
    }
    state
        .effective_bases
        .get_with(base.to_string(), async {
            let probe = state.html_client.head(base.clone()).timeout(Duration::from_secs(5));
            match apply_common_request_headers(probe, headers, &base, false, false).send().await {
                Ok(res) if matches!(res.url().scheme(), "http" | "https") => res.url().clone(),
                _ => base.clone(),
            }
        })
        .await
}

fn resolve_target(raw: &str, headers: &HeaderMap) -> Option<(String, Option<String>)> {
    if let Some(target) = decoded_target(raw) {
        return Some(target);
    }
    let referer = Url::parse(headers.get("referer")?.to_str().ok()?).ok()?;
    let target = referer.path().strip_prefix(constants::MOCHI_PREFIX)
        .or_else(|| referer.path().strip_prefix(constants::COVER_PREFIX))?;
    let mut target = target.to_owned();
    if let Some(query) = referer.query() {
        target.push('?');
        target.push_str(query);
    }
    let (base, _) = decoded_target(&target)?;
    let base = Url::parse(&base).ok()?;
    if !matches!(base.scheme(), "http" | "https") { return None; }
    Some((base.join(raw).ok()?.to_string(), None))
}

pub async fn proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    ws: Option<WebSocketUpgrade>,
    client_permit: Option<axum::Extension<Arc<crate::admission::ClientPermit>>>,
    req_body: Body,
) -> Response {
    proxy_metrics().requests.fetch_add(1, Ordering::Relaxed);
    let req_body = match upstream_body(&method, &headers, req_body).await {
        Ok(body) => body,
        Err(response) => return *response,
    };
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let is_cover_request = uri.path().starts_with(constants::COVER_PREFIX);
    let prefix = if is_cover_request { constants::COVER_PREFIX } else { constants::MOCHI_PREFIX };
    let raw_target = path_and_query.strip_prefix(prefix).unwrap_or(path_and_query);
    let (decoded_target_owned, valid_token) = match resolve_target(raw_target, &headers) {
        Some(target) => target,
        None => return classified_error_response(
            StatusCode::BAD_REQUEST,
            "invalid-request",
            "resource source context is missing or invalid",
        ),
    };
    let decoded_target_owned = match token_relative(raw_target) {
        Some((_, base, suffix)) if !suffix.is_empty() && !suffix.starts_with('?') => {
            effective_base(&state, &headers, base)
                .await
                .join(suffix)
                .map(String::from)
                .unwrap_or(decoded_target_owned)
        }
        _ => decoded_target_owned,
    };
    let target_url_str: &str = &decoded_target_owned;
    debug!("proxying request");

    if let Some(ws) = ws {
        if target_url_str.starts_with("ws/") || headers.contains_key("upgrade") {
            let real_target = if let Some(remaining) = target_url_str.strip_prefix("ws/") {
                if remaining.starts_with("http") {
                    remaining
                        .replace("http://", "ws://")
                        .replace("https://", "wss://")
                } else if remaining.starts_with("wss://") {
                    remaining.to_string()
                } else {
                    let decoded = urlencoding::decode(remaining)
                        .unwrap_or(std::borrow::Cow::Borrowed(remaining));
                    if decoded.starts_with("wss://") || decoded.starts_with("ws://") {
                        decoded.into_owned()
                    } else {
                        target_url_str
                            .replace("ws/", "https://")
                            .replace("http://", "ws://")
                            .replace("https://", "wss://")
                    }
                }
            } else {
                if target_url_str.starts_with("http") {
                    target_url_str
                        .replace("http://", "ws://")
                        .replace("https://", "wss://")
                } else {
                    format!("wss://{}", target_url_str)
                }
            };
            let validation_target = real_target
                .replacen("wss://", "https://", 1)
                .replacen("ws://", "http://", 1);
            let validation_url = match Url::parse(&validation_target) {
                Ok(url) => url,
                Err(_) => {
                    return classified_error_response(
                        StatusCode::BAD_REQUEST,
                        "invalid-request",
                        "invalid websocket target",
                    )
                }
            };
            let Ok(permit) = state.websocket_permit.clone().try_acquire_owned() else {
                return classified_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "infrastructure",
                    "websocket capacity is temporarily exhausted",
                );
            };
            let (upstream, protocol) =
                match websocket::connect(&real_target, &validation_url, &headers).await {
                    Ok(connected) => connected,
                    Err(_) => {
                        return classified_error_response(
                            StatusCode::BAD_GATEWAY,
                            "network",
                            "websocket connection failed",
                        )
                    }
                };
            let ws = if let Some(protocol) = protocol {
                ws.protocols([protocol])
            } else {
                ws
            };
            return ws
                .max_message_size(websocket::MAX_MESSAGE_SIZE)
                .max_frame_size(websocket::MAX_MESSAGE_SIZE)
                .on_upgrade(move |socket| async move {
                    let _permit = permit;
                    let _client_permit = client_permit;
                    handle_socket(socket, upstream).await;
                });
        }
    }

    let target_url_string = target_url_str.to_string();
    let target_url = match Url::parse(&target_url_string) {
        Ok(url) => url,
        Err(_) => {
            return classified_error_response(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "invalid upstream url",
            )
        }
    };
    if let Err(reason) = validate_public_target(&target_url) {
        warn!("blocked proxy target: {}{}", reason, NEGATIVE);
        return classified_error_response(
            StatusCode::FORBIDDEN,
            "invalid-request",
            "game source target is not allowed",
        );
    }

    let force_refresh = request_bypasses_cache(&headers);

    let request_cache_allowed = request_allows_shared_cache(&headers);
    if method == Method::GET && request_cache_allowed && !force_refresh && !headers.contains_key("range") {
        proxy_metrics().cache_candidates.fetch_add(1, Ordering::Relaxed);
    } else {
        proxy_metrics().cache_bypasses.fetch_add(1, Ordering::Relaxed);
    }

    if method == Method::GET
        && !force_refresh
        && request_cache_allowed
        && !headers.contains_key("range")
    {
        if let Some(cached) = state
            .cache
            .get(target_url_str)
            .await
            .filter(|entry| stream_cache_fresh(&entry.headers))
        {
            proxy_metrics().cache_hits.fetch_add(1, Ordering::Relaxed);
            crate::cache::touch_cache_file(get_cache_path(target_url_str));
            let mut res_headers = cached.headers.clone();
            if res_headers
                .get("content-type")
                .is_some_and(|v| v.as_bytes().starts_with(b"text/html"))
            {
                add_base_cookie(&mut res_headers, valid_token.as_deref());
            }
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));

            fix_game_content_type(target_url_str, &mut res_headers);
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return (status, res_headers, cached.body.clone()).into_response();
        }
    }

    if state.blocklist_matcher.is_match(&target_url_string) {
        let mut headers = HeaderMap::new();
        headers.insert(
            "Content-Type",
            HeaderValue::from_static("application/javascript"),
        );
        return (
            StatusCode::OK,
            headers,
            format!("/* {} */", negative_message("request blocked")),
        )
            .into_response();
    }

    let is_likely_asset = is_likely_static_asset_fast(&target_url_string);
    let looks_like_html_page =
        target_url_string.ends_with(".html") || target_url_string.ends_with(".htm");

    if method == Method::GET && is_cover_request {
        let mut response = fetch_and_cache(
            &state,
            &target_url,
            &target_url_string,
            target_url_str,
            &headers,
            &req_body.buffered(),
            Some(MAX_COVER_BODY_SIZE),
        )
        .await
        .unwrap_or_else(|error| *error);
        if !response.status().is_success() {
            response.headers_mut().insert(
                "Cache-Control",
                HeaderValue::from_static("no-store, must-revalidate"),
            );
        }
        return response;
    }

    if method == Method::GET && is_likely_asset {
        return fetch_and_cache(
            &state,
            &target_url,
            &target_url_string,
            target_url_str,
            &headers,
            &req_body.buffered(),
            None,
        )
        .await
        .unwrap_or_else(|error| *error);
    }

    let Some(request_permit) = state
        .request_permit
        .acquire_timeout(Duration::from_secs(5))
        .await
    else {
        return classified_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "infrastructure",
            "proxy capacity is temporarily exhausted",
        );
    };

    let client = if is_likely_asset {
        &state.asset_client
    } else {
        &state.html_client
    };

    let upstream_res = match send_upstream_with_retries(
        client,
        &method,
        &target_url,
        &headers,
        req_body,
        is_likely_asset,
        looks_like_html_page,
    )
    .await
    {
        Ok(res) => res,
        Err(error) => {
            proxy_metrics()
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            return upstream_failure(&error);
        }
    };

    let status = upstream_res.status();
    debug!("upstream response status: {}", status);

    if status == StatusCode::NOT_MODIFIED {
        return not_modified_response(upstream_res.headers());
    }

    if status.is_redirection() {
        return classified_error_response(
            StatusCode::BAD_GATEWAY,
            "unavailable",
            "game source redirected too many times",
        );
    }

    if status.is_client_error() || status.is_server_error() {
        return passthrough_response(upstream_res, request_permit);
    }

    let res_headers_ref = upstream_res.headers();

    let mut safe_headers = build_safe_response_headers(res_headers_ref, is_likely_asset);

    fix_game_content_type(&target_url_string, &mut safe_headers);
    insert_proxied_miss_headers(&mut safe_headers);

    let content_type = safe_headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();

    let content_type_lower = content_type.to_ascii_lowercase();
    let is_html = (content_type_lower.contains("text/html")
        || (content_type == "application/octet-stream"
            && (target_url_str.ends_with(".html") || target_url_str.ends_with(".htm")))
        || (content_type == "text/plain"
            && (target_url_str.ends_with(".html") || target_url_str.ends_with(".htm"))))
        && !target_url_str.ends_with(".swf")
        && !target_url_str.ends_with(".wasm");

    if is_html
        && status == StatusCode::OK
        && !headers.contains_key("range")
        && !is_likely_asset
        && method == Method::GET
    {
        safe_headers.remove("content-length");
        safe_headers.remove("content-encoding");

        let html_permit = match state
            .html_rewrite_permit
            .acquire_timeout(Duration::from_secs(5))
            .await
        {
            Some(permit) => permit,
            None => {
                return classified_error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "infrastructure",
                    "proxy capacity is temporarily exhausted",
                );
            }
        };

        let effective_url = upstream_res.url().clone();
        state
            .effective_bases
            .insert(target_url.to_string(), effective_url.clone())
            .await;

        let full_body = match read_limited_body(upstream_res, MAX_HTML_BODY_SIZE).await {
            Ok(body) => body,
            Err(_) => {
                return classified_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upstream-data",
                    "game page is too large to process",
                );
            }
        };

        let effective_url_clone = effective_url.clone();

        let body_vec = match tokio::task::spawn_blocking(move || {
            let _permit = html_permit;
            let base_url_str = effective_url_clone.to_string();
            rewrite_html(&full_body, &effective_url_clone, &base_url_str)
        })
        .await
        {
            Ok(Ok(body)) => body,
            _ => {
                proxy_metrics()
                    .implementation_errors
                    .fetch_add(1, Ordering::Relaxed);
                error!("html rewrite failed{}", NEGATIVE);
                return classified_error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "implementation",
                    "game page processing failed",
                );
            }
        };

        proxy_metrics()
            .html_rewrites
            .fetch_add(1, Ordering::Relaxed);

        let body_bytes = Bytes::from(body_vec);

        if shared_cache_allowed(&headers, &safe_headers, force_refresh) {
            prepare_proxy_cache_headers(&mut safe_headers);
        }
        if shared_cache_allowed(&headers, &safe_headers, force_refresh)
            && stream_cache_fresh(&safe_headers)
            && !body_bytes.is_empty()
            && body_bytes.len() <= state.max_cache_entry_size
        {
            let status_u16 = status.as_u16();
            let cache_key = target_url_str.to_string();
            let safe_headers_for_cache = safe_headers.clone();
            let cached_body = body_bytes.clone();

            let cached = Arc::new(CachedResponse {
                status: status_u16,
                headers: safe_headers_for_cache,
                body: cached_body.clone(),
            });

            state.cache.insert(cache_key.clone(), cached.clone()).await;

            let headers_for_disk = safe_headers.clone();
            let body_for_disk = cached_body;
            tokio::spawn(async move {
                write_to_disk(&cache_key, status_u16, &headers_for_disk, &body_for_disk).await;
            });
        }

        add_base_cookie(&mut safe_headers, valid_token.as_deref());
        return (status, safe_headers, Body::from(body_bytes)).into_response();
    }

    let is_image = content_type.starts_with("image/");
    let is_json = content_type.contains("json");
    let is_favicon_heuristic = target_url_str.contains("favicons?");
    let is_css = content_type.contains("text/css");
    let is_js = content_type.contains("javascript");
    let is_font = content_type.starts_with("font/") || content_type.contains("font");
    let is_wasm = content_type.contains("wasm");
    let should_cache = (is_likely_asset
        || is_image
        || is_json
        || is_favicon_heuristic
        || is_css
        || is_js
        || is_font
        || is_wasm)
        && status == StatusCode::OK
        && method == Method::GET
        && request_cache_allowed
        && !force_refresh
        && response_allows_shared_cache(&safe_headers)
        && !headers.contains_key("upgrade")
        && !headers.contains_key("range");
    if should_cache {
        prepare_proxy_cache_headers(&mut safe_headers);
    }
    let should_cache = should_cache && stream_cache_fresh(&safe_headers);

    if is_css && status == StatusCode::OK && !headers.contains_key("range") && method == Method::GET
    {
        safe_headers.remove("content-length");
        let full_body = match read_limited_body(upstream_res, MAX_CSS_BODY_SIZE).await {
            Ok(body) => body,
            Err(_) => {
                return classified_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upstream-data",
                    "stylesheet is too large to process",
                );
            }
        };
        let css_str = String::from_utf8_lossy(&full_body);
        let rewritten_css = rewrite_css_urls(&css_str, &target_url);
        let rewritten_bytes = Bytes::from(rewritten_css.into_bytes());

        if should_cache && rewritten_bytes.len() <= state.max_cache_entry_size {
            let cached = Arc::new(CachedResponse {
                status: status.as_u16(),
                headers: safe_headers.clone(),
                body: rewritten_bytes.clone(),
            });
            state.cache.insert(target_url_str.to_string(), cached).await;
        }

        return (status, safe_headers, Body::from(rewritten_bytes)).into_response();
    }

    if should_cache {
        let (sender_tx, sender_rx) =
            mpsc::channel::<Result<Bytes, std::io::Error>>(state.channel_buffer);
        let target_url_str_owned = target_url_str.to_string();
        let max_entry = state.max_cache_entry_size;
        let state_clone = state.clone();
        let status_u16 = status.as_u16();
        let safe_headers_clone = safe_headers.clone();
        let capacity = upstream_res
            .content_length()
            .filter(|len| *len < max_entry as u64)
            .map_or(0, |len| (len as usize).min(state.ram_cache_limit));

        tokio::spawn(async move {
            let _request_permit = request_permit;
            let mut stream = upstream_res.bytes_stream();
            let mut accumulator = Vec::with_capacity(capacity);
            let mut total_size = 0usize;
            let mut aborted = false;

            loop {
                let item = tokio::select! {
                    biased;
                    _ = sender_tx.closed() => {
                        aborted = true;
                        break;
                    }
                    item = stream.next() => item,
                };
                let Some(item) = item else { break };
                match item {
                    Ok(chunk) => {
                        total_size += chunk.len();
                        if total_size < max_entry {
                            accumulator.extend_from_slice(&chunk);
                        } else {
                            accumulator = Vec::new();
                        }
                        if sender_tx.send(Ok(chunk)).await.is_err() {
                            aborted = true;
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = sender_tx
                            .send(Err(std::io::Error::other(
                                "upstream stream failed... /ᐠ - ˕ -マ",
                            )))
                            .await;
                        aborted = true;
                        break;
                    }
                }
            }

            if !aborted && total_size < max_entry && total_size > 0 {
                let body_bytes = Bytes::from(accumulator);
                let cached = Arc::new(CachedResponse {
                    status: status_u16,
                    headers: safe_headers_clone,
                    body: body_bytes,
                });
                state_clone.cache.insert(target_url_str_owned, cached).await;
            }
        });

        let stream_body = Body::from_stream(ReceiverStream::new(sender_rx));
        return (status, safe_headers, stream_body).into_response();
    }

    let stream = upstream_res.bytes_stream().map(move |item| {
        let _permit = &request_permit;
        item
    });
    let stream = Body::from_stream(stream);
    (status, safe_headers, stream).into_response()
}

