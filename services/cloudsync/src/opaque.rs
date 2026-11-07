use crate::auth::{
    auth_error, auth_success, failure_message, get_recent_user, negative, new_sync_salt,
    start_session, sync_salt, valid_username, AppState, AuthFailure, UserResponse,
};
use axum::{
    extract::{rejection::JsonRejection, Json, State},
    http::{header::RETRY_AFTER, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use dashmap::DashMap;
use hmac::{Hmac, Mac};
use opaque_ke::{
    CipherSuite, CredentialFinalization, CredentialRequest, RegistrationRequest,
    RegistrationUpload, Ristretto255, ServerLogin, ServerLoginParameters, ServerRegistration,
    ServerSetup, TripleDh,
};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Sha256, Sha512};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tower_cookies::Cookies;

pub(crate) struct Suite;

impl CipherSuite for Suite {
    type OprfCs = Ristretto255;
    type KeyExchange = TripleDh<Ristretto255, Sha512>;
    type Ksf = argon2::Argon2<'static>;
}

pub(crate) fn decode(field: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(field).ok()
}

pub(crate) fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub(crate) fn server_setup_from_env() -> ServerSetup<Suite> {
    let raw = std::env::var("OPAQUE_SERVER_SETUP")
        .unwrap_or_else(|_| panic!("opaque server setup is missing... /ᐠ - ˕ -マ"));
    decode(raw.trim())
        .and_then(|bytes| ServerSetup::<Suite>::deserialize(&bytes).ok())
        .unwrap_or_else(|| panic!("opaque server setup is invalid... /ᐠ - ˕ -マ"))
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Attempt {
    Allowed,
    Locked { retry_after: u64 },
}

pub(crate) fn count_attempt(
    conn: &rusqlite::Connection,
    user_id: i64,
    now: i64,
) -> rusqlite::Result<Attempt> {
    let tx = rusqlite::Transaction::new_unchecked(conn, rusqlite::TransactionBehavior::Immediate)?;
    let (failed, locked_until): (i64, i64) = tx.query_row(
        "SELECT COALESCE(failed_logins, 0), COALESCE(locked_until, 0) FROM users WHERE id = ?1",
        [user_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if now < locked_until {
        return Ok(Attempt::Locked {
            retry_after: (locked_until - now) as u64,
        });
    }
    let failed = failed.saturating_add(1);
    let locked_until = if failed >= 6 {
        now + (60i64 << (failed - 6).min(6)).min(3600)
    } else {
        locked_until
    };
    tx.execute(
        "UPDATE users SET failed_logins = ?1, locked_until = ?2 WHERE id = ?3",
        rusqlite::params![failed, locked_until, user_id],
    )?;
    tx.commit()?;
    Ok(Attempt::Allowed)
}

pub(crate) fn reset_attempts(conn: &rusqlite::Connection, user_id: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?1",
        [user_id],
    )?;
    Ok(())
}

const WRAPPED_KEY_BYTES: usize = 61;
const PENDING_LOGIN_TTL: Duration = Duration::from_secs(60);
const PENDING_LOGIN_MAX_ENTRIES: usize = 10_000;
const UPGRADE_SESSION_MAX_AGE_SECS: i64 = 300;

#[derive(Deserialize)]
pub struct RegisterStartRequest {
    pub username: String,
    pub request: String,
}

#[derive(Deserialize)]
pub struct RegisterFinishRequest {
    pub username: String,
    pub credential_id: String,
    pub record: String,
    pub wrapped_key: String,
}

#[derive(Deserialize)]
pub struct LoginStartRequest {
    pub username: String,
    pub request: String,
}

#[derive(Deserialize)]
pub struct LoginFinishRequest {
    pub login_id: String,
    pub finalization: String,
}

#[derive(Deserialize)]
pub struct UpgradeStartRequest {
    pub request: String,
}

#[derive(Deserialize)]
pub struct UpgradeFinishRequest {
    pub credential_id: String,
    pub record: String,
    pub wrapped_key: String,
}

#[derive(Serialize)]
struct LoginSuccess {
    success: bool,
    user: UserResponse,
    wrapped_key: String,
}

struct PendingLogin {
    state: ServerLogin<Suite>,
    user: (i64, String),
    created: Instant,
}

static PENDING_LOGINS: OnceLock<DashMap<String, PendingLogin>> = OnceLock::new();

fn pending_logins() -> &'static DashMap<String, PendingLogin> {
    PENDING_LOGINS.get_or_init(DashMap::new)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn random_id() -> String {
    let mut id = [0u8; 16];
    OsRng.fill_bytes(&mut id);
    hex(&id)
}

fn valid_credential_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn decoy_credential(setup: &ServerSetup<Suite>, username: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(&setup.serialize())
        .expect("decoy key is invalid... /ᐠ - ˕ -マ");
    mac.update(b"lyra-opaque-decoy:");
    mac.update(username.as_bytes());
    hex(&mac.finalize().into_bytes()[..16])
}

fn remember_login(login: PendingLogin) -> String {
    let login_id = random_id();
    let pending = pending_logins();
    if pending.len() >= PENDING_LOGIN_MAX_ENTRIES {
        pending.retain(|_, entry| entry.created.elapsed() < PENDING_LOGIN_TTL);
    }
    if pending.len() >= PENDING_LOGIN_MAX_ENTRIES {
        let evicted = pending.iter().next().map(|entry| entry.key().clone());
        if let Some(key) = evicted {
            pending.remove(&key);
        }
    }
    pending.insert(login_id.clone(), login);
    login_id
}

fn rejected(status: StatusCode, failure: AuthFailure) -> Response {
    auth_error(status, failure_message(failure)).into_response()
}

fn unauthorized() -> Response {
    rejected(StatusCode::UNAUTHORIZED, AuthFailure::InvalidCredentials)
}

pub(crate) fn too_many_attempts(retry_after: u64) -> Response {
    let (status, body) = auth_error(StatusCode::TOO_MANY_REQUESTS, negative("too many attempts"));
    (status, [(RETRY_AFTER, retry_after.to_string())], body).into_response()
}

fn registration_request(request: &str) -> Option<RegistrationRequest<Suite>> {
    decode(request).and_then(|bytes| RegistrationRequest::<Suite>::deserialize(&bytes).ok())
}

fn registration_start_response(state: &AppState, request: RegistrationRequest<Suite>) -> Response {
    let credential_id = random_id();
    match ServerRegistration::<Suite>::start(&state.opaque_setup, request, credential_id.as_bytes())
    {
        Ok(start) => Json(serde_json::json!({
            "response": encode(&start.message.serialize()),
            "credential_id": credential_id,
        }))
        .into_response(),
        Err(_) => rejected(StatusCode::INTERNAL_SERVER_ERROR, AuthFailure::Internal),
    }
}

fn registration_upload(record: &str, wrapped_key: &str) -> (Option<Vec<u8>>, Option<Vec<u8>>) {
    let record = decode(record)
        .and_then(|bytes| RegistrationUpload::<Suite>::deserialize(&bytes).ok())
        .map(|upload| ServerRegistration::finish(upload).serialize().to_vec());
    let wrapped_key = decode(wrapped_key).filter(|bytes| bytes.len() == WRAPPED_KEY_BYTES);
    (record, wrapped_key)
}

pub async fn register_start(
    State(state): State<Arc<AppState>>,
    payload: Result<Json<RegisterStartRequest>, JsonRejection>,
) -> Response {
    let Json(RegisterStartRequest { username, request }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejected(rejection.status(), AuthFailure::InvalidRequest),
    };
    let request = registration_request(&request);
    let (true, Some(request)) = (valid_username(&username), request) else {
        return rejected(StatusCode::BAD_REQUEST, AuthFailure::InvalidRequest);
    };

    let pool = state.pool.clone();
    let lookup = username.clone();
    let taken = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        conn.query_row(
            "SELECT 1 FROM users WHERE username = ?",
            params![lookup],
            |_| Ok(()),
        )
        .optional()
        .map(|row| row.is_some())
        .map_err(|_| AuthFailure::Internal)
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal));
    match taken {
        Ok(false) => {}
        Ok(true) => return rejected(StatusCode::CONFLICT, AuthFailure::UsernameTaken),
        Err(failure) => return rejected(StatusCode::INTERNAL_SERVER_ERROR, failure),
    }

    registration_start_response(&state, request)
}

pub async fn register_finish(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    payload: Result<Json<RegisterFinishRequest>, JsonRejection>,
) -> Response {
    let Json(RegisterFinishRequest {
        username,
        credential_id,
        record,
        wrapped_key,
    }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejected(rejection.status(), AuthFailure::InvalidRequest),
    };
    let (record, wrapped_key) = registration_upload(&record, &wrapped_key);
    let (true, true, Some(record), Some(wrapped_key)) = (
        valid_username(&username),
        valid_credential_id(&credential_id),
        record,
        wrapped_key,
    ) else {
        return rejected(StatusCode::BAD_REQUEST, AuthFailure::InvalidRequest);
    };

    let pool = state.pool.clone();
    let stored_username = username.clone();
    let result = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        conn.execute(
            "INSERT INTO users (username, password_hash, token_version, sync_salt, opaque_credential, opaque_record, wrapped_key) VALUES (?, '', 1, ?, ?, ?, ?)",
            params![stored_username, new_sync_salt(), credential_id, record, wrapped_key],
        )
        .map_err(|error| match error {
            rusqlite::Error::SqliteFailure(error, _)
                if error.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE =>
            {
                AuthFailure::UsernameTaken
            }
            _ => AuthFailure::Internal,
        })?;
        let user_id = conn.last_insert_rowid();
        let sync_salt = sync_salt(&conn, user_id).map_err(|_| AuthFailure::Internal)?;
        Ok((user_id, sync_salt))
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal))
    .and_then(|(user_id, sync_salt)| {
        start_session(&state, &cookies, user_id, &username, 1)?;
        Ok((user_id, sync_salt))
    });

    match result {
        Ok((id, sync_salt)) => auth_success(
            StatusCode::CREATED,
            Some(UserResponse {
                id,
                username,
                sync_salt,
                created_at: None,
            }),
        )
        .into_response(),
        Err(AuthFailure::UsernameTaken) => {
            rejected(StatusCode::CONFLICT, AuthFailure::UsernameTaken)
        }
        Err(failure) => rejected(StatusCode::INTERNAL_SERVER_ERROR, failure),
    }
}

pub async fn upgrade_start(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    payload: Result<Json<UpgradeStartRequest>, JsonRejection>,
) -> Response {
    let Ok((id, _)) = get_recent_user(&state, &cookies, UPGRADE_SESSION_MAX_AGE_SECS).await else {
        return unauthorized();
    };
    let Json(UpgradeStartRequest { request }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejected(rejection.status(), AuthFailure::InvalidRequest),
    };
    let Some(request) = registration_request(&request) else {
        return rejected(StatusCode::BAD_REQUEST, AuthFailure::InvalidRequest);
    };

    let pool = state.pool.clone();
    let legacy = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        conn.query_row(
            "SELECT opaque_record IS NULL FROM users WHERE id = ?",
            params![id],
            |row| row.get::<_, bool>(0),
        )
        .optional()
        .map_err(|_| AuthFailure::Internal)
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal));
    match legacy {
        Ok(Some(true)) => {}
        Ok(_) => return unauthorized(),
        Err(failure) => return rejected(StatusCode::INTERNAL_SERVER_ERROR, failure),
    }

    registration_start_response(&state, request)
}

pub async fn upgrade_finish(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    payload: Result<Json<UpgradeFinishRequest>, JsonRejection>,
) -> Response {
    let Ok((id, _)) = get_recent_user(&state, &cookies, UPGRADE_SESSION_MAX_AGE_SECS).await else {
        return unauthorized();
    };
    let Json(UpgradeFinishRequest {
        credential_id,
        record,
        wrapped_key,
    }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejected(rejection.status(), AuthFailure::InvalidRequest),
    };
    let (record, wrapped_key) = registration_upload(&record, &wrapped_key);
    let (true, Some(record), Some(wrapped_key)) =
        (valid_credential_id(&credential_id), record, wrapped_key)
    else {
        return rejected(StatusCode::BAD_REQUEST, AuthFailure::InvalidRequest);
    };

    let pool = state.pool.clone();
    let changed = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        conn.execute(
            "UPDATE users SET opaque_record = ?, opaque_credential = ?, wrapped_key = ?, password_hash = '' WHERE id = ? AND opaque_record IS NULL",
            params![record, credential_id, wrapped_key, id],
        )
        .map_err(|_| AuthFailure::Internal)
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal));

    match changed {
        Ok(0) => rejected(StatusCode::CONFLICT, AuthFailure::InvalidRequest),
        Ok(_) => auth_success(StatusCode::OK, None).into_response(),
        Err(failure) => rejected(StatusCode::INTERNAL_SERVER_ERROR, failure),
    }
}

type LoginRow = (i64, String, Option<Vec<u8>>, Option<String>);

enum LoginLookup {
    Legacy,
    Locked(u64),
    Ready(Option<(i64, String, Vec<u8>, String)>),
}

pub async fn login_start(
    State(state): State<Arc<AppState>>,
    payload: Result<Json<LoginStartRequest>, JsonRejection>,
) -> Response {
    let Json(LoginStartRequest { username, request }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejected(rejection.status(), AuthFailure::InvalidRequest),
    };
    let request =
        decode(&request).and_then(|bytes| CredentialRequest::<Suite>::deserialize(&bytes).ok());
    let (true, Some(request)) = (valid_username(&username), request) else {
        return rejected(StatusCode::BAD_REQUEST, AuthFailure::InvalidRequest);
    };

    let pool = state.pool.clone();
    let lookup = username.clone();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let found = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        let row: Option<LoginRow> = conn
            .query_row(
                "SELECT id, username, opaque_record, opaque_credential FROM users WHERE username = ?",
                params![lookup],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| AuthFailure::Internal)?;
        let Some((id, username, record, credential)) = row else {
            return Ok(LoginLookup::Ready(None));
        };
        let Some(record) = record else {
            return Ok(LoginLookup::Legacy);
        };
        let credential = credential.ok_or(AuthFailure::Internal)?;
        if let Attempt::Locked { retry_after } =
            count_attempt(&conn, id, now).map_err(|_| AuthFailure::Internal)?
        {
            return Ok(LoginLookup::Locked(retry_after));
        }
        Ok(LoginLookup::Ready(Some((id, username, record, credential))))
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal));

    let (user, record, credential) = match found {
        Ok(LoginLookup::Legacy) => {
            return Json(serde_json::json!({ "legacy": true })).into_response()
        }
        Ok(LoginLookup::Locked(retry_after)) => return too_many_attempts(retry_after),
        Ok(LoginLookup::Ready(Some((id, username, record, credential)))) => {
            match ServerRegistration::<Suite>::deserialize(&record) {
                Ok(record) => (Some((id, username)), Some(record), credential),
                Err(_) => {
                    return rejected(StatusCode::INTERNAL_SERVER_ERROR, AuthFailure::Internal)
                }
            }
        }
        Ok(LoginLookup::Ready(None)) => {
            (None, None, decoy_credential(&state.opaque_setup, &username))
        }
        Err(failure) => return rejected(StatusCode::INTERNAL_SERVER_ERROR, failure),
    };

    let Ok(start) = ServerLogin::start(
        &mut OsRng,
        &state.opaque_setup,
        record,
        request,
        credential.as_bytes(),
        ServerLoginParameters::default(),
    ) else {
        return rejected(StatusCode::INTERNAL_SERVER_ERROR, AuthFailure::Internal);
    };
    let response = encode(&start.message.serialize());
    let login_id = match user {
        Some(user) => remember_login(PendingLogin {
            state: start.state,
            user,
            created: Instant::now(),
        }),
        None => random_id(),
    };
    Json(serde_json::json!({ "login_id": login_id, "response": response })).into_response()
}

pub async fn login_finish(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    payload: Result<Json<LoginFinishRequest>, JsonRejection>,
) -> Response {
    let Json(LoginFinishRequest {
        login_id,
        finalization,
    }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => return rejected(rejection.status(), AuthFailure::InvalidRequest),
    };
    let Some((_, pending)) = pending_logins().remove(&login_id) else {
        return unauthorized();
    };
    let PendingLogin {
        state: login,
        user,
        created,
    } = pending;
    if created.elapsed() >= PENDING_LOGIN_TTL {
        return unauthorized();
    }
    let (id, username) = user;
    let Some(finalization) = decode(&finalization)
        .and_then(|bytes| CredentialFinalization::<Suite>::deserialize(&bytes).ok())
    else {
        return unauthorized();
    };
    if login
        .finish(finalization, ServerLoginParameters::default())
        .is_err()
    {
        return unauthorized();
    }

    let pool = state.pool.clone();
    let loaded = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        reset_attempts(&conn, id).map_err(|_| AuthFailure::Internal)?;
        let (token_version, wrapped_key): (i64, Vec<u8>) = conn
            .query_row(
                "SELECT token_version, wrapped_key FROM users WHERE id = ?",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => AuthFailure::InvalidCredentials,
                _ => AuthFailure::Internal,
            })?;
        let sync_salt = sync_salt(&conn, id).map_err(|_| AuthFailure::Internal)?;
        Ok((token_version, wrapped_key, sync_salt))
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal))
    .and_then(|(token_version, wrapped_key, sync_salt)| {
        start_session(&state, &cookies, id, &username, token_version)?;
        Ok((wrapped_key, sync_salt))
    });

    match loaded {
        Ok((wrapped_key, sync_salt)) => (
            StatusCode::OK,
            Json(LoginSuccess {
                success: true,
                user: UserResponse {
                    id,
                    username,
                    sync_salt,
                    created_at: None,
                },
                wrapped_key: encode(&wrapped_key),
            }),
        )
            .into_response(),
        Err(AuthFailure::InvalidCredentials) => unauthorized(),
        Err(failure) => rejected(StatusCode::INTERNAL_SERVER_ERROR, failure),
    }
}


