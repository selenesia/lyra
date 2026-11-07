use super::*;

pub(super) fn has_media_signature(body: &[u8], offset: usize) -> bool {
    let Some(body) = body.get(offset..) else {
        return false;
    };
    let transport_stream = body.first() == Some(&0x47) && body.get(188) == Some(&0x47);
    let fragmented_mp4 = body
        .get(4..8)
        .is_some_and(|marker| matches!(marker, b"ftyp" | b"styp" | b"moof"));
    transport_stream || fragmented_mp4
}

pub(super) fn media_prefix_len(body: &[u8]) -> usize {
    if has_media_signature(body, 0) {
        0
    } else if has_media_signature(body, SEGMENT_PREFIX_BYTES) {
        SEGMENT_PREFIX_BYTES
    } else {
        0
    }
}

#[derive(Clone, Copy)]
pub(super) enum CacheStatus {
    Memory,
    Disk,
    Miss,
    Coalesced,
}

impl CacheStatus {
    pub(super) fn header(self) -> HeaderValue {
        HeaderValue::from_static(match self {
            Self::Memory => "HIT",
            Self::Disk => "DISK",
            Self::Miss => "MISS",
            Self::Coalesced => "COALESCED",
        })
    }
}

pub(super) fn parse_byte_range(value: &str, length: usize) -> Result<(usize, usize), ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?;
    if value.contains(',') || length == 0 {
        return Err(());
    }
    let (start, end) = value.split_once('-').ok_or(())?;
    if start.is_empty() {
        let suffix = end.parse::<usize>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        return Ok((length.saturating_sub(suffix), length - 1));
    }
    let start = start.parse::<usize>().map_err(|_| ())?;
    if start >= length {
        return Err(());
    }
    let end = if end.is_empty() {
        length - 1
    } else {
        end.parse::<usize>().map_err(|_| ())?.min(length - 1)
    };
    (start <= end).then_some((start, end)).ok_or(())
}

pub(super) fn set_cached_age(headers: &mut HeaderMap) {
    if let Some(age) =
        crate::cache::response_age(headers, std::time::SystemTime::now(), Duration::ZERO)
    {
        if let Ok(value) = HeaderValue::from_str(&age.as_secs().to_string()) {
            headers.insert("age", value);
        }
    }
}

pub(super) fn cached_response(
    cached: Arc<CachedResponse>,
    method: &Method,
    request_headers: &HeaderMap,
    cache_status: CacheStatus,
) -> Response {
    let mut status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
    let mut headers = cached.headers.clone();
    set_cached_age(&mut headers);
    let upstream_content_type = headers.get(CONTENT_TYPE).cloned();
    headers.insert(
        CONTENT_TYPE,
        normalized_content_type(&cached.body, upstream_content_type),
    );
    headers.insert("X-Cache", cache_status.header());
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    let mut body = cached.body.clone();

    if status == StatusCode::OK {
        if let Some(range) = request_headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
        {
            STREAM_METRICS
                .range_requests
                .fetch_add(1, Ordering::Relaxed);
            match parse_byte_range(range, body.len()) {
                Ok((start, end)) => {
                    status = StatusCode::PARTIAL_CONTENT;
                    body = body.slice(start..=end);
                    if let Ok(value) =
                        HeaderValue::from_str(&format!("bytes {start}-{end}/{}", cached.body.len()))
                    {
                        headers.insert(CONTENT_RANGE, value);
                    }
                }
                Err(()) => {
                    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    if let Ok(value) =
                        HeaderValue::from_str(&format!("bytes */{}", cached.body.len()))
                    {
                        response.headers_mut().insert(CONTENT_RANGE, value);
                    }
                    response
                        .headers_mut()
                        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                    response
                        .headers_mut()
                        .insert("X-Cache", cache_status.header());
                    return response;
                }
            }
        }
    }

    if let Ok(value) = HeaderValue::from_str(&body.len().to_string()) {
        headers.insert(CONTENT_LENGTH, value);
    }
    if method != Method::HEAD {
        STREAM_METRICS
            .bytes_served
            .fetch_add(body.len() as u64, Ordering::Relaxed);
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from(body)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

pub(super) fn normalized_content_type(body: &Bytes, upstream: Option<HeaderValue>) -> HeaderValue {
    let is_transport_stream =
        body.first() == Some(&0x47) && (body.len() <= 188 || body.get(188) == Some(&0x47));
    if is_transport_stream {
        return HeaderValue::from_static("video/mp2t");
    }
    if body.len() >= 8 && matches!(&body[4..8], b"ftyp" | b"styp" | b"moof") {
        return HeaderValue::from_static("video/mp4");
    }
    upstream.unwrap_or_else(|| HeaderValue::from_static("application/octet-stream"))
}

pub(super) struct DownstreamBodyMetrics {
    pub(super) expected: u64,
    pub(super) yielded: u64,
    pub(super) failed: bool,
}

impl DownstreamBodyMetrics {
    pub(super) fn observe(&mut self, item: &std::io::Result<Bytes>) {
        match item {
            Ok(chunk) => {
                self.yielded = self.yielded.saturating_add(chunk.len() as u64);
                STREAM_METRICS
                    .bytes_served
                    .fetch_add(chunk.len() as u64, Ordering::Relaxed);
            }
            Err(_) => self.failed = true,
        }
    }
}

impl Drop for DownstreamBodyMetrics {
    fn drop(&mut self) {
        if !self.failed && self.yielded < self.expected {
            STREAM_METRICS
                .downstream_cancellations
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(super) struct SegmentFillAttempt {
    handed_off: bool,
}

impl SegmentFillAttempt {
    pub(super) fn start() -> Self {
        Self { handed_off: false }
    }

    pub(super) fn hand_off(&mut self) {
        self.handed_off = true;
    }
}

impl Drop for SegmentFillAttempt {
    fn drop(&mut self) {
        if !self.handed_off {
            STREAM_METRICS
                .segment_failed_fills
                .fetch_add(1, Ordering::Relaxed);
        }
    }
}

pub(super) async fn disk_cached_response(
    mut cached: StreamDiskEntry,
    method: &Method,
    request_headers: &HeaderMap,
    cache_status: CacheStatus,
) -> Result<Response, ResolveError> {
    let total_len = usize::try_from(cached.body_len).map_err(|_| ResolveError::TooLarge)?;
    let mut status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
    let mut headers = cached.headers;
    set_cached_age(&mut headers);
    headers.insert("X-Cache", cache_status.header());
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.remove(CONTENT_RANGE);

    let mut start = 0usize;
    let mut end = total_len.saturating_sub(1);
    if status == StatusCode::OK {
        if let Some(range) = request_headers
            .get(RANGE)
            .and_then(|value| value.to_str().ok())
        {
            STREAM_METRICS
                .range_requests
                .fetch_add(1, Ordering::Relaxed);
            match parse_byte_range(range, total_len) {
                Ok((range_start, range_end)) => {
                    start = range_start;
                    end = range_end;
                    status = StatusCode::PARTIAL_CONTENT;
                    if let Ok(value) =
                        HeaderValue::from_str(&format!("bytes {start}-{end}/{total_len}"))
                    {
                        headers.insert(CONTENT_RANGE, value);
                    }
                }
                Err(()) => {
                    let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                    if let Ok(value) = HeaderValue::from_str(&format!("bytes */{total_len}")) {
                        response.headers_mut().insert(CONTENT_RANGE, value);
                    }
                    response
                        .headers_mut()
                        .insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                    response
                        .headers_mut()
                        .insert("X-Cache", cache_status.header());
                    return Ok(response);
                }
            }
        }
    }

    let response_len = if total_len == 0 { 0 } else { end - start + 1 };
    headers.insert(
        CONTENT_LENGTH,
        HeaderValue::from_str(&response_len.to_string()).map_err(|_| ResolveError::Upstream)?,
    );
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        cached
            .reader
            .seek(SeekFrom::Start(cached.body_offset + start as u64))
            .await
            .map_err(|_| ResolveError::Upstream)?;
        let reader = cached.reader.take(response_len as u64);
        let mut metrics = DownstreamBodyMetrics {
            expected: response_len as u64,
            yielded: 0,
            failed: false,
        };
        let stream = ReaderStream::with_capacity(reader, DISK_READ_CHUNK_BYTES).map(move |item| {
            metrics.observe(&item);
            item
        });
        Body::from_stream(stream)
    };
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    Ok(response)
}
