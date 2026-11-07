use crate::admission::Operation;
use crate::auth::{get_current_user, AppState};
use aes_gcm::{
    aead::{Aead, AeadCore, Payload},
    Aes256Gcm, Nonce,
};
use axum::{
    body::Bytes,
    extract::{Json, State},
    http::{
        header::{CONTENT_ENCODING, CONTENT_TYPE},
        HeaderMap, StatusCode,
    },
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use dashmap::DashMap;
use rand::rngs::OsRng;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    sync::{Arc, OnceLock},
    time::Instant,
};
use tower_cookies::Cookies;

mod payload;
mod sensitivity;
mod validation;

use payload::*;
use sensitivity::*;
use validation::*;

#[path = "transfer.rs"]
pub mod transfer;

const SCHEMA_VERSION: u64 = 3;
const LEGACY_STRUCTURED_SCHEMA_VERSION: u64 = 2;
const IV_LENGTH: usize = 12;
const BLOB_MAGIC: &[u8; 4] = b"wcs1";
const MAX_JSON_DEPTH: usize = 120;
const MAX_RAW_SIZE: usize = 80 * 1024 * 1024;
const MAX_BLOB_SIZE: usize = 80 * 1024 * 1024;
const MAX_DECOMPRESSED_SIZE: usize = 80 * 1024 * 1024;
const META_CACHE_TTL_SECS: u64 = 60;
const META_CACHE_MAX_ENTRIES: usize = 10_000;
const NEGATIVE: &str = "... /ᐠ - ˕ -マ";

static META_CACHE: OnceLock<DashMap<i64, (String, Instant)>> = OnceLock::new();

#[derive(Serialize)]
struct SyncResponse {
    success: bool,
    data: Option<Value>,
    updated_at: Option<String>,
    code: Option<&'static str>,
    error: Option<String>,
}

#[derive(Serialize)]
struct DownloadResponse {
    success: bool,
    data: Snapshot,
    updated_at: String,
    code: Option<&'static str>,
    error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncError {
    Unauthorized,
    InvalidPayload,
    UnsupportedMediaType,
    UnsupportedEncoding,
    Unprocessable,
    TooDeep,
    TooLarge,
    Missing,
    Corrupt,
    Busy,
    Conflict,
    RevisionConflict,
    Sealed,
    Internal,
}

impl SyncError {
    fn status(self) -> StatusCode {
        match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::InvalidPayload | Self::TooDeep => StatusCode::BAD_REQUEST,
            Self::UnsupportedMediaType | Self::UnsupportedEncoding => {
                StatusCode::UNSUPPORTED_MEDIA_TYPE
            }
            Self::Unprocessable => StatusCode::UNPROCESSABLE_ENTITY,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Missing => StatusCode::NOT_FOUND,
            Self::Busy => StatusCode::SERVICE_UNAVAILABLE,
            Self::Conflict | Self::RevisionConflict => StatusCode::CONFLICT,
            Self::Sealed => StatusCode::LOCKED,
            Self::Corrupt | Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::InvalidPayload => "invalid_sync_payload",
            Self::UnsupportedMediaType => "invalid_sync_content_type",
            Self::UnsupportedEncoding => "invalid_sync_content_encoding",
            Self::Unprocessable => "invalid_sync_payload",
            Self::TooDeep => "sync_payload_too_deep",
            Self::TooLarge => "sync_payload_too_large",
            Self::Missing => "sync_data_not_found",
            Self::Corrupt => "sync_data_unavailable",
            Self::Busy => "sync_service_busy",
            Self::Conflict => "sync_transfer_changed",
            Self::RevisionConflict => "sync_revision_conflict",
            Self::Sealed => "sync_data_sealed",
            Self::Internal => "sync_service_unavailable",
        }
    }

    fn message(self) -> String {
        let message = match self {
            Self::Unauthorized => "unauthorized",
            Self::InvalidPayload => "invalid sync payload",
            Self::UnsupportedMediaType => "sync content type is unsupported",
            Self::UnsupportedEncoding => "sync content encoding is unsupported",
            Self::Unprocessable => "invalid sync payload",
            Self::TooDeep => "sync payload is too deeply nested",
            Self::TooLarge => "sync payload is too large",
            Self::Missing => "no synced data found",
            Self::Corrupt => "synced data is unavailable",
            Self::Busy => "sync service is busy",
            Self::Conflict => "sync changed; try again",
            Self::RevisionConflict => "sync changed on another device",
            Self::Sealed => "synced data is end-to-end encrypted",
            Self::Internal => "sync service is unavailable",
        };
        format!("{message}{NEGATIVE}")
    }
}

type SyncResult<T> = Result<T, SyncError>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Snapshot {
    schema_version: u64,
    local_storage: HashMap<String, String>,
    session_storage: HashMap<String, String>,
    cookies: CookiePayload,
    #[serde(rename = "indexedDB")]
    indexed_db: HashMap<String, Database>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum CookiePayload {
    Legacy(HashMap<String, String>),
    Current(Vec<SyncCookie>),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncCookie {
    name: String,
    value: String,
    domain: Option<String>,
    path: String,
    expires: Option<f64>,
    same_site: String,
    secure: bool,
    partitioned: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Database {
    stores: HashMap<String, Store>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Store {
    key_path: Value,
    auto_increment: bool,
    indexes: HashMap<String, Index>,
    records: Vec<Record>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    key_path: Value,
    unique: bool,
    multi_entry: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    key: Value,
    value: Value,
}

fn response(
    success: bool,
    data: Option<Value>,
    updated_at: Option<String>,
    error: Option<SyncError>,
) -> Response {
    let status = error.map_or(StatusCode::OK, SyncError::status);
    let mut result = (
        status,
        Json(SyncResponse {
            success,
            data,
            updated_at,
            code: error.map(SyncError::code),
            error: error.map(SyncError::message),
        }),
    )
        .into_response();
    if error == Some(SyncError::Busy) {
        result.headers_mut().insert(
            axum::http::header::RETRY_AFTER,
            axum::http::HeaderValue::from_static("1"),
        );
    }
    result
}

fn get_meta_cache() -> &'static DashMap<i64, (String, Instant)> {
    META_CACHE.get_or_init(DashMap::new)
}

fn cached_meta_get(user_id: i64) -> Option<String> {
    let cache = get_meta_cache();
    if let Some(entry) = cache.get(&user_id) {
        let (updated_at, created_at) = entry.value();
        if created_at.elapsed().as_secs() < META_CACHE_TTL_SECS {
            return Some(updated_at.clone());
        }
        drop(entry);
        cache.remove(&user_id);
    }
    None
}

fn cached_meta_set(user_id: i64, updated_at: String) {
    let cache = get_meta_cache();
    if cache.len() >= META_CACHE_MAX_ENTRIES {
        let evicted = cache.iter().next().map(|entry| *entry.key());
        if let Some(user_id) = evicted {
            cache.remove(&user_id);
        }
    }
    cache.insert(user_id, (updated_at, Instant::now()));
}

pub fn cached_meta_invalidate(user_id: i64) {
    get_meta_cache().remove(&user_id);
}

pub async fn meta(State(state): State<Arc<AppState>>, cookies: Cookies) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    if let Some(updated_at) = cached_meta_get(user_id) {
        return response(true, None, Some(updated_at), None);
    }
    let pool = state.pool.clone();
    let result = tokio::task::spawn_blocking(move || {
        let connection = pool.get().map_err(|_| SyncError::Internal)?;
        let updated_at = connection
            .query_row(
                "SELECT updated_at FROM sync_data WHERE user_id = ?",
                params![user_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default();
        Ok::<_, SyncError>(updated_at)
    })
    .await;
    match result {
        Ok(Ok(updated_at)) => {
            if !updated_at.is_empty() {
                cached_meta_set(user_id, updated_at.clone());
            }
            response(true, None, Some(updated_at), None)
        }
        _ => response(false, None, None, Some(SyncError::Internal)),
    }
}

pub async fn upload(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    headers: HeaderMap,
    request: axum::extract::Request,
) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    let content_type_valid = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type.trim().eq_ignore_ascii_case("application/json")
            })
        });
    if !content_type_valid {
        return response(false, None, None, Some(SyncError::UnsupportedMediaType));
    }
    let permit = match state
        .sync_admission
        .acquire(user_id, Operation::Snapshot, &state.sync_work)
        .await
    {
        Some(permit) => permit,
        None => return response(false, None, None, Some(SyncError::Busy)),
    };
    let payload = match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        axum::body::to_bytes(request.into_body(), MAX_RAW_SIZE),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => return response(false, None, None, Some(SyncError::TooLarge)),
        Err(_) => return response(false, None, None, Some(SyncError::Busy)),
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let payload = decode_upload_payload(&headers, &payload)?;
        let updated_at = store_payload_for_user(&state, user_id, payload)?;
        cached_meta_set(user_id, updated_at.clone());
        Ok::<_, SyncError>(updated_at)
    })
    .await
    .unwrap_or(Err(SyncError::Internal));
    match result {
        Ok(updated_at) => response(true, None, Some(updated_at), None),
        Err(error) => response(false, None, None, Some(error)),
    }
}

pub async fn download(State(state): State<Arc<AppState>>, cookies: Cookies) -> impl IntoResponse {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    let permit = match state
        .sync_admission
        .acquire(user_id, Operation::Snapshot, &state.sync_work)
        .await
    {
        Some(permit) => permit,
        None => return response(false, None, None, Some(SyncError::Busy)),
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (data, updated_at) = load_payload_for_user(&state, user_id)?;
        Ok::<_, SyncError>(
            Json(DownloadResponse {
                success: true,
                data,
                updated_at,
                code: None,
                error: None,
            })
            .into_response(),
        )
    })
    .await
    .unwrap_or(Err(SyncError::Internal));
    match result {
        Ok(response) => response,
        Err(error) => response(false, None, None, Some(error)),
    }
}
