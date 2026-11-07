use super::*;

pub(super) fn check_json_depth(value: &Value, depth: usize) -> bool {
    if depth > MAX_JSON_DEPTH {
        return false;
    }
    match value {
        Value::Object(map) => map.values().all(|entry| check_json_depth(entry, depth + 1)),
        Value::Array(entries) => entries
            .iter()
            .all(|entry| check_json_depth(entry, depth + 1)),
        _ => true,
    }
}

pub(super) fn valid_cookie_text(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| (0x21..=0x7e).contains(&byte) && !matches!(byte, b'"' | b';' | b',' | b'\\'))
}

pub(super) fn valid_cookie(cookie: &SyncCookie) -> bool {
    let valid_name = !cookie.name.is_empty()
        && cookie.name.len() <= 256
        && cookie.name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        });
    let valid_domain = cookie.domain.as_ref().is_none_or(|domain| {
        !domain.is_empty()
            && domain.len() <= 253
            && !domain.contains("..")
            && domain
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    });
    let valid_path = cookie.path.starts_with('/')
        && cookie.path.len() <= 1024
        && !cookie
            .path
            .bytes()
            .any(|byte| byte == b';' || byte < 0x20 || byte == 0x7f);
    let valid_expiry = cookie
        .expires
        .is_none_or(|expires| expires.is_finite() && (0.0..=8.64e15).contains(&expires));
    valid_name
        && !sensitive_name(&cookie.name)
        && !cookie.name.starts_with("__Http-")
        && !cookie.name.starts_with("__Host-Http-")
        && cookie.value.len() <= 4096
        && valid_cookie_text(&cookie.value)
        && !sensitive_text(&cookie.value, true)
        && valid_domain
        && valid_path
        && valid_expiry
        && matches!(cookie.same_site.as_str(), "strict" | "lax" | "none")
        && (cookie.same_site != "none" || cookie.secure)
        && (!cookie.partitioned || cookie.secure)
        && (!cookie.name.starts_with("__Secure-") || cookie.secure)
        && (!cookie.name.starts_with("__Host-")
            || (cookie.secure && cookie.domain.is_none() && cookie.path == "/"))
}

pub(super) fn exact_fields(map: &serde_json::Map<String, Value>, fields: &[&str]) -> bool {
    map.len() == fields.len() && fields.iter().all(|field| map.contains_key(*field))
}

pub(super) fn take_id(map: &serde_json::Map<String, Value>, ids: &mut HashSet<u64>) -> Option<u64> {
    let id = map.get("id")?.as_u64()?;
    if id == 0 || !ids.insert(id) {
        return None;
    }
    Some(id)
}

pub(super) fn valid_key_path(value: &Value) -> bool {
    value.is_null()
        || value.is_string()
        || value
            .as_array()
            .is_some_and(|entries| entries.iter().all(Value::is_string))
}

pub(super) fn valid_encoded(value: &Value, ids: &mut HashSet<u64>, allow_sensitive: bool) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    let Some(kind) = map.get("type").and_then(Value::as_str) else {
        return false;
    };
    match kind {
        "null" | "undefined" => exact_fields(map, &["type"]),
        "boolean" => {
            exact_fields(map, &["type", "value"]) && map.get("value").is_some_and(Value::is_boolean)
        }
        "string" => {
            exact_fields(map, &["type", "value"])
                && map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|value| allow_sensitive || !sensitive_text(value, true))
        }
        "bigint" => {
            exact_fields(map, &["type", "value"])
                && map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|number| {
                        let digits = number.strip_prefix('-').unwrap_or(number);
                        !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
                    })
        }
        "number" => {
            exact_fields(map, &["type", "value"])
                && map.get("value").is_some_and(|number| {
                    number.is_number()
                        || matches!(
                            number.as_str(),
                            Some("nan" | "infinity" | "-infinity" | "-0")
                        )
                })
        }
        "reference" => {
            exact_fields(map, &["type", "value"])
                && map
                    .get("value")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| ids.contains(&id))
        }
        "date" => {
            exact_fields(map, &["type", "id", "value"])
                && take_id(map, ids).is_some()
                && map.get("value").is_some_and(Value::is_string)
        }
        "array_buffer" => {
            exact_fields(map, &["type", "id", "value"])
                && take_id(map, ids).is_some()
                && map
                    .get("value")
                    .and_then(Value::as_str)
                    .is_some_and(|value| allow_sensitive || safe_encoded_bytes(value))
        }
        "regexp" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|regexp| {
                    exact_fields(regexp, &["source", "flags"])
                        && regexp.get("source").is_some_and(Value::is_string)
                        && regexp.get("flags").is_some_and(Value::is_string)
                })
        }
        "array" | "set" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries
                        .iter()
                        .all(|entry| valid_encoded(entry, ids, allow_sensitive))
                })
        }
        "object" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|entries| {
                    entries.iter().all(|(key, entry)| {
                        (allow_sensitive || !sensitive_name(key))
                            && valid_encoded(entry, ids, allow_sensitive)
                    })
                })
        }
        "map" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries.iter().all(|entry| {
                        entry.as_array().is_some_and(|pair| {
                            pair.len() == 2
                                && encoded_string(&pair[0])
                                    .is_none_or(|key| allow_sensitive || !sensitive_name(key))
                                && valid_encoded(&pair[0], ids, allow_sensitive)
                                && valid_encoded(&pair[1], ids, allow_sensitive)
                        })
                    })
                })
        }
        "typed_array" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|typed| {
                    exact_fields(typed, &["name", "buffer", "byteOffset", "length"])
                        && typed
                            .get("name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| {
                                matches!(
                                    name,
                                    "DataView"
                                        | "Int8Array"
                                        | "Uint8Array"
                                        | "Uint8ClampedArray"
                                        | "Int16Array"
                                        | "Uint16Array"
                                        | "Int32Array"
                                        | "Uint32Array"
                                        | "Float32Array"
                                        | "Float64Array"
                                        | "BigInt64Array"
                                        | "BigUint64Array"
                                )
                            })
                        && typed.get("byteOffset").and_then(Value::as_u64).is_some()
                        && typed.get("length").and_then(Value::as_u64).is_some()
                        && typed
                            .get("buffer")
                            .is_some_and(|buffer| valid_encoded(buffer, ids, allow_sensitive))
                })
        }
        "blob" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|blob| {
                    exact_fields(blob, &["mediaType", "bytes"])
                        && blob.get("mediaType").is_some_and(Value::is_string)
                        && blob
                            .get("bytes")
                            .and_then(Value::as_str)
                            .is_some_and(|value| allow_sensitive || safe_encoded_bytes(value))
                })
        }
        "file" => {
            if !exact_fields(map, &["type", "id", "value"]) || take_id(map, ids).is_none() {
                return false;
            }
            map.get("value")
                .and_then(Value::as_object)
                .is_some_and(|file| {
                    exact_fields(file, &["name", "mediaType", "lastModified", "bytes"])
                        && file.get("name").is_some_and(Value::is_string)
                        && file.get("mediaType").is_some_and(Value::is_string)
                        && file.get("lastModified").and_then(Value::as_u64).is_some()
                        && file
                            .get("bytes")
                            .and_then(Value::as_str)
                            .is_some_and(|value| allow_sensitive || safe_encoded_bytes(value))
                })
        }
        _ => false,
    }
}

pub(super) fn encoded_string(value: &Value) -> Option<&str> {
    let map = value.as_object()?;
    (map.get("type")?.as_str()? == "string")
        .then(|| map.get("value")?.as_str())
        .flatten()
}

pub(super) fn valid_folio_cookie(cookie: &Value, allow_sensitive: bool) -> bool {
    let Some(cookie) = cookie.as_object() else {
        return false;
    };
    let Some(name) = cookie.get("name").and_then(Value::as_str) else {
        return false;
    };
    let Some(value) = cookie.get("value").and_then(Value::as_str) else {
        return false;
    };
    if name.len() > 256 || value.len() > 4096 || cookie.len() > 32 {
        return false;
    }
    if cookie
        .get("domain")
        .is_none_or(|domain| domain.as_str().is_some_and(|value| value.len() <= 253))
        && cookie.get("path").is_none_or(|path| {
            path.as_str()
                .is_some_and(|value| value.starts_with('/') && value.len() <= 1024)
        })
        && cookie
            .get("sameSite")
            .is_none_or(|same_site| same_site.as_str().is_some_and(|value| value.len() <= 64))
        && ["hostOnly", "secure", "httpOnly", "partitioned"]
            .iter()
            .all(|field| cookie.get(*field).is_none_or(Value::is_boolean))
        && ["expires", "maxAge"]
            .iter()
            .all(|field| cookie.get(*field).is_none_or(Value::is_number))
        && cookie.iter().all(|(key, value)| {
            key.len() <= 256
                && (value.is_null() || value.is_string() || value.is_boolean() || value.is_number())
        })
        && (allow_sensitive
            || (cookie.get("httpOnly").and_then(Value::as_bool) != Some(true)
                && !sensitive_name(name)
                && !sensitive_text(value, true)))
    {
        return true;
    }
    false
}

pub(super) fn validate_folio_cookies(record: &Record, allow_sensitive: bool) -> bool {
    if encoded_string(&record.key) != Some("cookies") {
        return true;
    }
    let Some(value) = record.value.as_object() else {
        return false;
    };
    let Some(fields) = value.get("value").and_then(Value::as_object) else {
        return false;
    };
    let Some(cookie_dump) = fields.get("cookies").and_then(encoded_string) else {
        return false;
    };
    let Ok(cookies) = serde_json::from_str::<HashMap<String, Value>>(cookie_dump) else {
        return false;
    };
    cookies
        .iter()
        .all(|(id, cookie)| id.len() <= 2048 && valid_folio_cookie(cookie, allow_sensitive))
}

pub(super) fn validate_raw_size(size: usize) -> SyncResult<()> {
    (size <= MAX_RAW_SIZE)
        .then_some(())
        .ok_or(SyncError::TooLarge)
}

pub(super) fn decode_upload_payload(headers: &HeaderMap, payload: &[u8]) -> SyncResult<Snapshot> {
    let encoding = headers
        .get(CONTENT_ENCODING)
        .map(|value| value.to_str().map_err(|_| SyncError::UnsupportedEncoding))
        .transpose()?
        .unwrap_or("identity")
        .trim();
    let decoded;
    let payload = if encoding.eq_ignore_ascii_case("identity") || encoding.is_empty() {
        validate_raw_size(payload.len())?;
        payload
    } else if encoding.eq_ignore_ascii_case("gzip") {
        let decoder = flate2::read::GzDecoder::new(payload);
        let mut limited = decoder.take((MAX_RAW_SIZE + 1) as u64);
        decoded = {
            let mut bytes = Vec::new();
            limited
                .read_to_end(&mut bytes)
                .map_err(|_| SyncError::Unprocessable)?;
            validate_raw_size(bytes.len())?;
            bytes
        };
        decoded.as_slice()
    } else {
        return Err(SyncError::UnsupportedEncoding);
    };
    let snapshot =
        serde_json::from_slice::<Snapshot>(payload).map_err(|_| SyncError::Unprocessable)?;
    validate_decoded_snapshot(&snapshot)?;
    Ok(snapshot)
}

pub(super) fn validate_decoded_snapshot(snapshot: &Snapshot) -> SyncResult<()> {
    let include_sensitive = snapshot.schema_version == SCHEMA_VERSION;
    for values in [&snapshot.local_storage, &snapshot.session_storage] {
        if values.iter().any(|(key, value)| {
            let allow_sensitive = include_sensitive && site_storage_name(key);
            !allow_sensitive && (sensitive_name(key) || sensitive_text(value, true))
        }) {
            return Err(SyncError::InvalidPayload);
        }
    }
    match (snapshot.schema_version, &snapshot.cookies) {
        (1, CookiePayload::Legacy(cookies)) => {
            if cookies.iter().any(|(name, value)| {
                sensitive_name(name) || sensitive_text(value, true) || !valid_cookie_text(value)
            }) {
                return Err(SyncError::InvalidPayload);
            }
        }
        (LEGACY_STRUCTURED_SCHEMA_VERSION | SCHEMA_VERSION, CookiePayload::Current(cookies)) => {
            if cookies.iter().any(|cookie| !valid_cookie(cookie)) {
                return Err(SyncError::InvalidPayload);
            }
            let mut identities = HashSet::new();
            for cookie in cookies {
                let identity = (
                    cookie.name.clone(),
                    cookie
                        .domain
                        .as_ref()
                        .map(|domain| domain.to_ascii_lowercase()),
                    cookie.path.clone(),
                    cookie.partitioned,
                );
                if !identities.insert(identity) {
                    return Err(SyncError::InvalidPayload);
                }
            }
        }
        _ => return Err(SyncError::InvalidPayload),
    }
    for (database_name, database) in &snapshot.indexed_db {
        let allow_sensitive = include_sensitive && allows_sensitive_database(database_name);
        if !allow_sensitive && sensitive_name(database_name) {
            return Err(SyncError::InvalidPayload);
        }
        for (store_name, store) in &database.stores {
            if (!allow_sensitive && sensitive_name(store_name))
                || !valid_key_path(&store.key_path)
                || (store.auto_increment && store.key_path.is_array())
            {
                return Err(SyncError::InvalidPayload);
            }
            for (index_name, index) in &store.indexes {
                if (!allow_sensitive && sensitive_name(index_name))
                    || !valid_key_path(&index.key_path)
                    || index.key_path.is_null()
                    || (index.multi_entry && index.key_path.is_array())
                {
                    return Err(SyncError::InvalidPayload);
                }
                let _ = index.unique;
            }
            for record in &store.records {
                if !check_json_depth(&record.key, 6) || !check_json_depth(&record.value, 6) {
                    return Err(SyncError::TooDeep);
                }
                let mut key_ids = HashSet::new();
                let mut value_ids = HashSet::new();
                if !valid_encoded(&record.key, &mut key_ids, allow_sensitive)
                    || !valid_encoded(&record.value, &mut value_ids, allow_sensitive)
                    || (!allow_sensitive && encoded_string(&record.key).is_some_and(sensitive_name))
                    || (database_name == "__folio_controller"
                        && store_name == "state"
                        && !validate_folio_cookies(record, allow_sensitive))
                {
                    return Err(SyncError::InvalidPayload);
                }
            }
        }
    }
    Ok(())
}
