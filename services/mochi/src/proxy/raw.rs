use super::*;

#[derive(serde::Serialize)]
pub(super) struct RawUpstreamMeta {
    status: u16,
    status_text: String,
    url: String,
    raw_headers: Vec<(String, String)>,
}

pub(super) fn encode_raw_upstream_meta(meta: &RawUpstreamMeta) -> Option<HeaderValue> {
    let json = serde_json::to_vec(meta).ok()?;
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json);
    HeaderValue::from_str(&encoded).ok()
}

pub(super) fn raw_target_from_uri(uri: &Uri) -> Option<String> {
    let path_and_query = uri.path_and_query().map(|p| p.as_str()).unwrap_or("");
    let prefix_pos = path_and_query.find(constants::MOCHI_RAW_PREFIX)?;
    let raw_target = &path_and_query[prefix_pos + constants::MOCHI_RAW_PREFIX.len()..];
    let decoded = urlencoding::decode(raw_target).ok()?.into_owned();

    if decoded.starts_with("http://") || decoded.starts_with("https://") {
        return Some(decoded);
    }

    decode_mochi_url(&decoded)
}

pub async fn raw_proxy_handler(
    State(state): State<Arc<AppState>>,
    method: Method,
    mut headers: HeaderMap,
    uri: Uri,
    req_body: Bytes,
) -> Response {
    proxy_metrics().raw_requests.fetch_add(1, Ordering::Relaxed);
    if method != Method::GET && method != Method::HEAD {
        return classified_error_response(
            StatusCode::METHOD_NOT_ALLOWED,
            "invalid-request",
            "method not supported",
        );
    }

    let target_url_string = match raw_target_from_uri(&uri) {
        Some(target) => target,
        None => {
            return classified_error_response(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "invalid raw target",
            )
        }
    };

    if state.blocklist_matcher.is_match(&target_url_string) {
        let meta = RawUpstreamMeta {
            status: StatusCode::OK.as_u16(),
            status_text: "OK".to_string(),
            url: target_url_string,
            raw_headers: vec![(
                "content-type".to_string(),
                "application/javascript".to_string(),
            )],
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            "content-type",
            HeaderValue::from_static("application/javascript"),
        );
        headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
        headers.insert(
            "access-control-expose-headers",
            HeaderValue::from_static("x-mochi-upstream-meta"),
        );
        if let Some(value) = encode_raw_upstream_meta(&meta) {
            headers.insert(MOCHI_UPSTREAM_META_HEADER, value);
        }
        return (
            StatusCode::OK,
            headers,
            format!("/* {} */", negative_message("request blocked")),
        )
            .into_response();
    }

    let target_url = match Url::parse(&target_url_string) {
        Ok(url) if url.scheme() == "http" || url.scheme() == "https" => url,
        _ => {
            return classified_error_response(
                StatusCode::BAD_REQUEST,
                "invalid-request",
                "invalid upstream url",
            )
        }
    };
    if let Err(reason) = validate_public_target(&target_url) {
        return (StatusCode::FORBIDDEN, negative_message(reason)).into_response();
    }

    for name in [
        "cookie",
        "authorization",
        "proxy-authorization",
        "origin",
        "referer",
    ] {
        headers.remove(name);
    }

    let Some(permit) = state
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

    let is_likely_asset = is_likely_static_asset_fast(&target_url_string);
    let looks_like_html_page =
        target_url_string.ends_with(".html") || target_url_string.ends_with(".htm");
    let upstream_res = match send_upstream_with_retries(
        &state.raw_client,
        &method,
        &target_url,
        &headers,
        UpstreamBody::Buffered(req_body),
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
    let upstream_url = upstream_res.url().to_string();
    let raw_headers = upstream_res
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_string(), v.to_str().ok()?.to_string())))
        .collect::<Vec<_>>();
    let meta = RawUpstreamMeta {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        url: upstream_url,
        raw_headers,
    };

    let mut safe_headers = build_safe_response_headers(upstream_res.headers(), is_likely_asset);
    safe_headers.remove("set-cookie");
    safe_headers.remove("content-length");
    if status.is_success() {
        fix_game_content_type(&target_url_string, &mut safe_headers);
    }
    safe_headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    safe_headers.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("x-mochi-upstream-meta"),
    );
    if let Some(value) = encode_raw_upstream_meta(&meta) {
        safe_headers.insert(MOCHI_UPSTREAM_META_HEADER, value);
    } else {
        return classified_error_response(
            StatusCode::BAD_GATEWAY,
            "implementation",
            "failed to encode upstream metadata",
        );
    }

    if method == Method::HEAD
        || status == StatusCode::NO_CONTENT
        || status == StatusCode::NOT_MODIFIED
    {
        return (StatusCode::OK, safe_headers).into_response();
    }

    let stream = upstream_res.bytes_stream().map(move |item| {
        let _permit = &permit;
        item
    });
    (StatusCode::OK, safe_headers, Body::from_stream(stream)).into_response()
}
