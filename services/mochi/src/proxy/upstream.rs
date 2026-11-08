use super::*;

pub(crate) fn safe_to_retry(method: &Method) -> bool {
    matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub(super) const MAX_BUFFERED_REQUEST_BODY: usize = 2 * 1024 * 1024;

pub(crate) enum UpstreamBody {
    Buffered(Bytes),
    Streamed {
        body: Option<Body>,
        content_length: u64,
    },
}

impl UpstreamBody {
    pub(super) fn buffered(&self) -> Bytes {
        match self {
            Self::Buffered(bytes) => bytes.clone(),
            Self::Streamed { .. } => Bytes::new(),
        }
    }
}

pub(super) async fn upstream_body(
    method: &Method,
    headers: &HeaderMap,
    body: Body,
) -> Result<UpstreamBody, Box<Response>> {
    let content_length = crate::upload::content_length(headers);
    if safe_to_retry(method)
        || content_length.is_some_and(|length| length <= MAX_BUFFERED_REQUEST_BODY as u64)
    {
        return axum::body::to_bytes(body, MAX_BUFFERED_REQUEST_BODY)
            .await
            .map(UpstreamBody::Buffered)
            .map_err(|_| {
                Box::new(classified_error_response(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "invalid-request",
                    "request body is too large",
                ))
            });
    }
    let (body, length) = match content_length {
        Some(length) => (body, length),
        None => crate::upload::spool(body, crate::upload::MAX_SPOOLED_BODY)
            .await
            .map_err(|error| {
                Box::new(classified_error_response(
                    error.status(),
                    "invalid-request",
                    error.message(),
                ))
            })?,
    };
    Ok(UpstreamBody::Streamed {
        body: Some(body),
        content_length: length,
    })
}

pub(super) fn is_retryable_upstream_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429) || status >= 500
}

pub(crate) fn upstream_error_category(error: &reqwest::Error) -> &'static str {
    use std::error::Error;
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            if io.kind() == std::io::ErrorKind::PermissionDenied {
                return "policy-denied";
            }
            if io.kind() == std::io::ErrorKind::InvalidInput {
                return "invalid-request";
            }
        }
        source = current.source();
    }
    if error.is_timeout() {
        "network-timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_body() || error.is_decode() {
        "upstream-data"
    } else {
        "network"
    }
}

pub(super) fn is_retryable_upstream_error(error: &reqwest::Error) -> bool {
    !matches!(
        upstream_error_category(error),
        "policy-denied" | "invalid-request" | "redirect"
    ) && (error.is_connect() || error.is_timeout())
}

pub(super) fn upstream_failure(error: &reqwest::Error) -> Response {
    if upstream_error_category(error) == "policy-denied" {
        proxy_metrics()
            .policy_denials
            .fetch_add(1, Ordering::Relaxed);
        return classified_error_response(
            StatusCode::BAD_GATEWAY,
            "policy-denied",
            "the source is blocked by network policy",
        );
    }
    upstream_network_error_response()
}

pub(super) fn upstream_network_error_response() -> Response {
    proxy_metrics()
        .network_errors
        .fetch_add(1, Ordering::Relaxed);
    classified_error_response(
        StatusCode::BAD_GATEWAY,
        "network",
        "the game source could not be reached",
    )
}

pub(super) fn classified_error_response(
    status: StatusCode,
    class: &'static str,
    message: &'static str,
) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert("cache-control", HeaderValue::from_static("no-store"));
    headers.insert("x-error-class", HeaderValue::from_static(class));
    (status, headers, negative_message(message)).into_response()
}

pub(super) fn apply_common_request_headers(
    mut req_builder: reqwest::RequestBuilder,
    headers: &HeaderMap,
    target_url: &Url,
    is_likely_asset: bool,
    is_html_page: bool,
) -> reqwest::RequestBuilder {
    for (k, v) in headers.iter() {
        let key_str = k.as_str();
        if !is_blacklisted_header(key_str)
            && !key_str.starts_with("cf-")
            && !key_str.starts_with("x-")
            && !matches!(key_str, "origin" | "referer" | "cookie")
        {
            if !is_likely_asset && key_str == "accept-encoding" {
                continue;
            }
            req_builder = req_builder.header(k, v);
        }
    }
    req_builder = req_builder.header("User-Agent", UA);
    req_builder = req_builder.header("Sec-Ch-Ua", SEC_CH_UA);
    req_builder = req_builder.header("Sec-Ch-Ua-Mobile", "?0");
    req_builder = req_builder.header("Sec-Ch-Ua-Platform", "\"Windows\"");
    req_builder = req_builder.header("Accept-Language", "en-US,en;q=0.9");

    if is_html_page {
        req_builder = req_builder.header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8");
        req_builder = req_builder.header("Sec-Fetch-Site", "cross-site");
        req_builder = req_builder.header("Sec-Fetch-Mode", "navigate");
        req_builder = req_builder.header("Sec-Fetch-Dest", "document");
        req_builder = req_builder.header("Sec-Fetch-User", "?1");
        req_builder = req_builder.header("Upgrade-Insecure-Requests", "1");
    } else {
        req_builder = req_builder.header("Sec-Fetch-Site", "same-origin");
        req_builder = req_builder.header("Sec-Fetch-Mode", "cors");
        req_builder = req_builder.header("Sec-Fetch-Dest", "empty");
        req_builder = req_builder.header("Priority", "u=1, i");
    }

    for value in headers.get_all("cookie") {
        if let Ok(value) = value.to_str() {
            let value = value
                .split(';')
                .map(str::trim)
                .filter(|cookie| {
                    !cookie
                        .split_once('=')
                        .is_some_and(|(name, _)| name.trim() == "mochi_base")
                })
                .collect::<Vec<_>>()
                .join("; ");
            if !value.is_empty() {
                req_builder = req_builder.header("cookie", value);
            }
        }
    }
    let origin = target_url.origin().ascii_serialization();
    if headers.contains_key("origin") {
        req_builder = req_builder.header("Origin", &origin);
    }
    req_builder = req_builder.header("Referer", format!("{}/", origin));
    req_builder
}

pub(super) async fn send_upstream_with_retries(
    client: &reqwest::Client,
    method: &Method,
    target_url: &Url,
    headers: &HeaderMap,
    mut req_body: UpstreamBody,
    is_likely_asset: bool,
    is_html_page: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    let mut last_error = None;

    let attempts = if safe_to_retry(method) {
        MAX_UPSTREAM_ATTEMPTS
    } else {
        1
    };
    for attempt in 0..attempts {
        proxy_metrics()
            .upstream_requests
            .fetch_add(1, Ordering::Relaxed);
        let mut req_builder = client.request(method.clone(), target_url.clone());
        req_builder = apply_common_request_headers(
            req_builder,
            headers,
            target_url,
            is_likely_asset,
            is_html_page,
        );

        match &mut req_body {
            UpstreamBody::Buffered(bytes) => {
                if !bytes.is_empty() {
                    req_builder = req_builder.body(bytes.clone());
                }
            }
            UpstreamBody::Streamed {
                body,
                content_length,
            } => {
                req_builder = req_builder.header(reqwest::header::CONTENT_LENGTH, *content_length);
                if let Some(body) = body.take() {
                    req_builder =
                        req_builder.body(reqwest::Body::wrap_stream(body.into_data_stream()));
                }
            }
        }
        let started = std::time::Instant::now();
        match req_builder.send().await {
            Ok(response) => {
                let class = usize::from(response.status().as_u16() / 100).min(5);
                proxy_metrics().upstream_statuses[class].fetch_add(1, Ordering::Relaxed);
                if attempt + 1 < attempts
                    && is_retryable_upstream_status(response.status().as_u16())
                {
                    proxy_metrics()
                        .upstream_retries
                        .fetch_add(1, Ordering::Relaxed);
                    drop(response);
                    sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                    continue;
                }
                return Ok(response);
            }
            Err(error) => {
                tracing::warn!(
                    category = upstream_error_category(&error),
                    attempt = attempt + 1,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    "upstream attempt failed... /ᐠ - ˕ -マ"
                );
                let should_retry = attempt + 1 < attempts && is_retryable_upstream_error(&error);
                if should_retry {
                    proxy_metrics()
                        .upstream_retries
                        .fetch_add(1, Ordering::Relaxed);
                    sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                }
                last_error = Some(error);
                if !should_retry {
                    break;
                }
            }
        }
    }

    Err(last_error.expect("upstream attempt did not produce a result... /ᐠ - ˕ -マ"))
}

pub(super) async fn read_limited_body(
    response: reqwest::Response,
    max_size: usize,
) -> Result<Bytes, ()> {
    if response
        .content_length()
        .is_some_and(|size| size > max_size as u64)
    {
        return Err(());
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if body.len().saturating_add(chunk.len()) > max_size {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(body))
}
