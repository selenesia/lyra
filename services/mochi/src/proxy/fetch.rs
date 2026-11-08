use super::*;

pub(super) fn remove_owned_coalesced_request(
    state: &AppState,
    key: &str,
    owner: &broadcast::Sender<Arc<CachedResponse>>,
) {
    state
        .coalesce
        .remove_if(key, |_, current| current.same_channel(owner));
}

pub(super) struct CoalescedRequest {
    state: Arc<AppState>,
    key: String,
    sender: broadcast::Sender<Arc<CachedResponse>>,
}

impl Drop for CoalescedRequest {
    fn drop(&mut self) {
        remove_owned_coalesced_request(&self.state, &self.key, &self.sender);
    }
}

pub(super) async fn fetch_and_cache(
    state: &Arc<AppState>,
    target_url: &Url,
    target_url_string: &str,
    target_url_str: &str,
    headers: &HeaderMap,
    req_body: &Bytes,
    max_body_size: Option<usize>,
) -> Result<Response, Box<Response>> {
    let force_refresh = request_bypasses_cache(headers);
    let request_cache_allowed = request_allows_shared_cache(headers);

    let has_range = headers.contains_key("range");

    if request_cache_allowed && !force_refresh && !has_range {
        if let Some(cached) = state
            .cache
            .get(target_url_str)
            .await
            .filter(|entry| stream_cache_fresh(&entry.headers))
        {
            proxy_metrics().cache_hits.fetch_add(1, Ordering::Relaxed);
            crate::cache::touch_cache_file(get_cache_path(target_url_str));
            let mut res_headers = cached.headers.clone();
            res_headers.insert("X-Cache", HeaderValue::from_static("HIT"));
            fix_game_content_type(target_url_string, &mut res_headers);
            let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
            return Ok((status, res_headers, cached.body.clone()).into_response());
        }
    }

    if request_cache_allowed && !force_refresh && !has_range {
        if let Some((mut response, promoted)) = load_from_disk(
            target_url_str,
            state.max_cache_entry_size,
            state.disk_cache_max_age_secs,
            state.ram_cache_limit,
        )
        .await
        {
            proxy_metrics()
                .disk_cache_hits
                .fetch_add(1, Ordering::Relaxed);
            debug!("disk cache hit");
            if let Some(cached) = promoted {
                state.cache.insert(target_url_str.to_string(), cached).await;
            }
            fix_game_content_type(target_url_string, response.headers_mut());
            return Ok(response);
        }
    }

    let (coalesce_tx_clone, coalesce_receiver) =
        if request_cache_allowed && !force_refresh && !has_range {
            match state.coalesce.entry(target_url_str.to_string()) {
                Entry::Occupied(entry) => {
                    proxy_metrics()
                        .coalesced_requests
                        .fetch_add(1, Ordering::Relaxed);
                    (None, Some(entry.get().subscribe()))
                }
                Entry::Vacant(entry) => {
                    let (coalesce_tx, _) = broadcast::channel::<Arc<CachedResponse>>(1);
                    entry.insert(coalesce_tx.clone());
                    (
                        Some(CoalescedRequest {
                            state: state.clone(),
                            key: target_url_str.to_string(),
                            sender: coalesce_tx,
                        }),
                        None,
                    )
                }
            }
        } else {
            (None, None)
        };

    if let Some(mut rx) = coalesce_receiver {
        debug!("coalescing request");

        match tokio::time::timeout(Duration::from_secs(30), rx.recv()).await {
            Ok(Ok(cached)) => {
                let mut res_headers = cached.headers.clone();
                res_headers.insert("X-Cache", HeaderValue::from_static("COALESCED"));
                fix_game_content_type(target_url_string, &mut res_headers);
                let status = StatusCode::from_u16(cached.status).unwrap_or(StatusCode::OK);
                return Ok((status, res_headers, cached.body.clone()).into_response());
            }

            Ok(Err(_)) => {}
            _ => {
                return Err(Box::new(classified_error_response(
                    StatusCode::GATEWAY_TIMEOUT,
                    "temporary-source",
                    "an identical upstream request is still in progress",
                )));
            }
        }
    }
    let Some(permit) = state
        .request_permit
        .acquire_timeout(Duration::from_secs(5))
        .await
    else {
        return Err(Box::new(classified_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "infrastructure",
            "proxy capacity is temporarily exhausted",
        )));
    };

    let client = &state.asset_client;
    let upstream_res = match send_upstream_with_retries(
        client,
        &Method::GET,
        target_url,
        headers,
        UpstreamBody::Buffered(req_body.clone()),
        true,
        false,
    )
    .await
    {
        Ok(res) => res,
        Err(error) => {
            proxy_metrics()
                .upstream_errors
                .fetch_add(1, Ordering::Relaxed);
            return Err(Box::new(upstream_failure(&error)));
        }
    };

    let status = upstream_res.status();

    if status == StatusCode::NOT_MODIFIED {
        return Ok(not_modified_response(upstream_res.headers()));
    }

    if max_body_size.is_some_and(|max_size| {
        upstream_res
            .content_length()
            .is_some_and(|size| size > max_size as u64)
    }) {
        return Err(Box::new(classified_error_response(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid-request",
            "asset is too large",
        )));
    }

    if status.is_redirection() {
        return Err(Box::new(classified_error_response(
            StatusCode::BAD_GATEWAY,
            "unavailable",
            "game source redirected too many times",
        )));
    }

    if status.is_client_error() || status.is_server_error() {
        return Ok(passthrough_response(upstream_res, permit));
    }

    let res_headers_ref = upstream_res.headers();
    let upstream_allows_shared_cache = response_allows_shared_cache(res_headers_ref);

    let mut safe_headers = build_safe_response_headers(res_headers_ref, true);

    if status == StatusCode::OK && request_cache_allowed {
        prepare_proxy_cache_headers(&mut safe_headers);
    }

    fix_game_content_type(target_url_string, &mut safe_headers);
    insert_proxied_miss_headers(&mut safe_headers);

    let should_cache = status == StatusCode::OK
        && !force_refresh
        && request_cache_allowed
        && upstream_allows_shared_cache
        && stream_cache_fresh(&safe_headers)
        && !has_range;

    let actually_cache = should_cache
        && match state.caching_inflight.entry(target_url_str.to_string()) {
            Entry::Occupied(_) => false,
            Entry::Vacant(entry) => {
                entry.insert(());
                true
            }
        };

    if actually_cache {
        let (sender_tx, sender_rx) =
            mpsc::channel::<Result<Bytes, std::io::Error>>(state.channel_buffer);
        let target_url_str_owned = target_url_str.to_string();
        let ram_limit = state.ram_cache_limit;
        let max_stream_size = max_body_size.unwrap_or(state.max_cache_entry_size);
        let state_clone = state.clone();
        let safe_headers_clone = safe_headers.clone();
        let content_length = upstream_res.content_length();
        let mut coalesce_owner =
            coalesce_tx_clone.filter(|_| content_length.is_none_or(|len| len < ram_limit as u64));

        tokio::spawn(async move {
            let _permit = permit;
            let cache_path = get_cache_path(&target_url_str_owned);
            let temp_path = format!("{}.{}.tmp", cache_path, uuid::Uuid::new_v4());
            let mut disk_write_success = true;

            let mut file = match File::create(&temp_path).await {
                Ok(f) => Some(disk_writer(f)),
                Err(e) => {
                    warn!(
                        "failed to create temporary file {}: {}{}",
                        temp_path, e, NEGATIVE
                    );
                    disk_write_success = false;
                    None
                }
            };

            if disk_write_success {
                if let Some(ref mut f) = file {
                    disk_write_success =
                        write_cache_header(f, status.as_u16(), &safe_headers_clone)
                            .await
                            .is_ok();
                }
            }

            if !disk_write_success {
                file = None;
                let _ = fs::remove_file(&temp_path).await;
            }

            let mut stream = upstream_res.bytes_stream();
            let mut is_too_large_for_ram =
                content_length.is_some_and(|len| len >= ram_limit as u64);
            let mut accumulator = if is_too_large_for_ram {
                Vec::new()
            } else {
                Vec::with_capacity(content_length.unwrap_or(0) as usize)
            };
            let mut total_size = 0;
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
                        let chunk_len = chunk.len();
                        total_size += chunk_len;

                        if total_size > max_stream_size && max_body_size.is_some() {
                            let _ = sender_tx
                                .send(Err(std::io::Error::new(
                                    std::io::ErrorKind::InvalidData,
                                    "asset is too large... /ᐠ - ˕ -マ",
                                )))
                                .await;
                            aborted = true;
                            break;
                        }

                        if total_size > max_stream_size && disk_write_success {
                            file = None;
                            disk_write_success = false;
                            is_too_large_for_ram = true;
                            accumulator = Vec::new();
                            let _ = fs::remove_file(&temp_path).await;
                        }

                        if !is_too_large_for_ram {
                            if total_size < ram_limit {
                                accumulator.extend_from_slice(&chunk);
                            } else {
                                is_too_large_for_ram = true;
                                accumulator = Vec::new();
                            }
                        }
                        if is_too_large_for_ram {
                            coalesce_owner = None;
                        }

                        if sender_tx.send(Ok(chunk.clone())).await.is_err() {
                            aborted = true;
                            break;
                        }

                        if let Some(ref mut f) = file {
                            if f.write_all(&chunk).await.is_err() {
                                file = None;
                                disk_write_success = false;
                                let _ = fs::remove_file(&temp_path).await;
                            }
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

            if !aborted && disk_write_success {
                if let Some(mut f) = file.take() {
                    if f.flush().await.is_ok() {
                        drop(f);
                        let _ = fs::rename(&temp_path, &cache_path).await;
                    } else {
                        let _ = fs::remove_file(&temp_path).await;
                    }
                }

                if !is_too_large_for_ram && total_size < ram_limit {
                    let body_bytes = Bytes::from(accumulator);
                    let cached = Arc::new(CachedResponse {
                        status: status.as_u16(),
                        headers: safe_headers_clone,
                        body: body_bytes,
                    });
                    state_clone
                        .cache
                        .insert(target_url_str_owned.clone(), cached.clone())
                        .await;
                    if let Some(coalesce_tx) = coalesce_owner.as_ref() {
                        let _ = coalesce_tx.sender.send(cached);
                    }
                }
            } else {
                let _ = fs::remove_file(&temp_path).await;
            }

            state_clone.caching_inflight.remove(&target_url_str_owned);
        });

        let stream_body = Body::from_stream(ReceiverStream::new(sender_rx));
        let response = (status, safe_headers, stream_body).into_response();

        return Ok(response);
    }

    let stream = upstream_res.bytes_stream().map(move |item| {
        let _permit = &permit;
        item
    });
    let stream = Body::from_stream(stream);
    let response = (status, safe_headers, stream).into_response();
    Ok(response)
}

pub(super) fn passthrough_response(
    response: reqwest::Response,
    permit: adaptive_capacity::AdaptivePermit,
) -> Response {
    let status = response.status();
    let mut headers = build_safe_response_headers(response.headers(), true);
    proxy_metrics()
        .upstream_errors
        .fetch_add(1, Ordering::Relaxed);
    let class = if is_retryable_upstream_status(status.as_u16()) {
        proxy_metrics()
            .temporary_source_errors
            .fetch_add(1, Ordering::Relaxed);
        "temporary-source"
    } else {
        proxy_metrics()
            .unavailable_source_errors
            .fetch_add(1, Ordering::Relaxed);
        "unavailable"
    };
    headers.insert("x-error-class", HeaderValue::from_static(class));
    let stream = response.bytes_stream().map(move |chunk| {
        let _permit = &permit;
        chunk
    });
    (status, headers, Body::from_stream(stream)).into_response()
}
