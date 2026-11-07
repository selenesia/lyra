use super::*;

pub(super) fn sanitize_forwarded_cookie(cookie: &str) -> String {
    let mut safe_cookie = String::with_capacity(cookie.len() + 8);
    let mut has_same_site_none = false;
    let mut has_secure = false;

    for (index, raw_attribute) in cookie.split(';').enumerate() {
        let attribute = raw_attribute.trim();
        if attribute.is_empty() {
            continue;
        }

        let (name, value) = attribute
            .split_once('=')
            .map(|(name, value)| (name.trim(), value.trim()))
            .unwrap_or((attribute, ""));

        let normalized = if index > 0 && name.eq_ignore_ascii_case("domain") {
            format!("NoDomain={value}")
        } else if index > 0 && name.eq_ignore_ascii_case("samesite") {
            if value.eq_ignore_ascii_case("none") {
                has_same_site_none = true;
            }
            if value.eq_ignore_ascii_case("strict") {
                "SameSite=Lax".to_string()
            } else {
                attribute.to_string()
            }
        } else {
            if index > 0 && name.eq_ignore_ascii_case("secure") && value.is_empty() {
                has_secure = true;
            }
            attribute.to_string()
        };

        if !safe_cookie.is_empty() {
            safe_cookie.push_str("; ");
        }
        safe_cookie.push_str(&normalized);
    }

    if has_same_site_none && !has_secure {
        safe_cookie.push_str("; Secure");
    }

    safe_cookie
}

pub(crate) fn build_safe_response_headers(
    res_headers_ref: &HeaderMap,
    is_likely_asset: bool,
) -> HeaderMap {
    let mut safe_headers = HeaderMap::with_capacity(res_headers_ref.len());
    for (k, v) in res_headers_ref.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_res_header(key_str) {
            if key_str == "set-cookie" {
                let cookie_str = v.to_str().unwrap_or("");
                let safe_cookie = sanitize_forwarded_cookie(cookie_str);
                safe_headers.append(k, HeaderValue::from_str(&safe_cookie).unwrap_or(v.clone()));
            } else {
                safe_headers.append(k, v.clone());
            }
        }
    }
    if is_likely_asset {
        if let Some(enc) = res_headers_ref.get("content-encoding") {
            safe_headers.insert("content-encoding", enc.clone());
        }
    }
    safe_headers
}

pub(super) fn insert_proxied_miss_headers(headers: &mut HeaderMap) {
    headers.insert("Access-Control-Allow-Origin", HeaderValue::from_static("*"));
    headers.insert(
        "Cross-Origin-Opener-Policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        "Cross-Origin-Embedder-Policy",
        HeaderValue::from_static("require-corp"),
    );
    headers.insert(
        "Cross-Origin-Resource-Policy",
        HeaderValue::from_static("cross-origin"),
    );
    headers.insert("X-Cache", HeaderValue::from_static("MISS"));
}

pub(super) fn request_allows_shared_cache(headers: &HeaderMap) -> bool {
    if headers.contains_key("authorization") || headers.contains_key("proxy-authorization") {
        return false;
    }

    headers.get_all("cookie").iter().all(|value| {
        value.to_str().is_ok_and(|value| {
            value
                .split(';')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .all(|cookie| {
                    cookie
                        .split_once('=')
                        .is_some_and(|(name, _)| name.trim() == "mochi_base")
                })
        })
    })
}

pub(super) fn prepare_proxy_cache_headers(headers: &mut HeaderMap) {
    if !response_allows_shared_cache(headers) {
        return;
    }
    if !headers.contains_key("cache-control") && !headers.contains_key("expires") {
        headers.insert(
            "cache-control",
            HeaderValue::from_static("public, max-age=300"),
        );
    }
    if !headers.contains_key("date") {
        headers.insert(
            "date",
            HeaderValue::from_str(&httpdate::fmt_http_date(SystemTime::now())).unwrap(),
        );
    }
}

pub(crate) fn response_allows_shared_cache(headers: &HeaderMap) -> bool {
    !headers.contains_key("set-cookie")
        && !headers.contains_key("content-range")
        && !headers
            .get_all("vary")
            .iter()
            .any(|v| v.to_str().map_or(true, |v| !v.trim().is_empty()))
        && !headers.get_all("cache-control").iter().any(|v| {
            v.to_str().map_or(true, |v| {
                v.split(',').any(|directive| {
                    matches!(
                        directive
                            .trim()
                            .split('=')
                            .next()
                            .unwrap_or("")
                            .trim()
                            .to_ascii_lowercase()
                            .as_str(),
                        "private" | "no-store" | "no-cache"
                    )
                })
            })
        })
}

pub(super) fn shared_cache_allowed(
    request_headers: &HeaderMap,
    response_headers: &HeaderMap,
    force_refresh: bool,
) -> bool {
    !force_refresh
        && request_allows_shared_cache(request_headers)
        && response_allows_shared_cache(response_headers)
}

pub(super) fn not_modified_response(headers: &HeaderMap) -> Response {
    (
        StatusCode::NOT_MODIFIED,
        build_safe_response_headers(headers, false),
    )
        .into_response()
}

pub(super) fn add_base_cookie(headers: &mut HeaderMap, token: Option<&str>) {
    if let Some(token) = token {
        if let Ok(value) =
            HeaderValue::from_str(&format!("mochi_base={token}; Path=/; SameSite=Lax"))
        {
            headers.append("set-cookie", value);
        }
    }
}
