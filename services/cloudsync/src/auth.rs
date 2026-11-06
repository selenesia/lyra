use crate::opaque::{count_attempt, reset_attempts, too_many_attempts, Attempt};
use adaptive_capacity::AdaptiveGate;
use aes_gcm::Aes256Gcm;
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Algorithm, Argon2, Params, Version,
};
use axum::{
    extract::{
        rejection::{JsonRejection, QueryRejection},
        Json, Query, State,
    },
    http::StatusCode,
    response::IntoResponse,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use dashmap::DashMap;
use jsonwebtoken::{
    decode, encode, Algorithm as JwtAlgorithm, DecodingKey, EncodingKey, Header, Validation,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Instant;
use time::Duration;
use tower_cookies::cookie::SameSite;
use tower_cookies::{Cookie, Cookies};
use zeroize::Zeroizing;

const COOKIE_NAME: &str = "token";
const NEGATIVE: &str = "... /ᐠ - ˕ -マ";
const MAX_PASSWORD_CHARS: usize = 128;
const TOKEN_CACHE_TTL_SECS: u64 = 60;
const TOKEN_CACHE_MAX_ENTRIES: usize = 10_000;
const SESSION_DAYS: i64 = 7;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AuthFailure {
    Internal,
    Busy,
    InvalidRequest,
    UsernameTaken,
    InvalidCredentials,
}

pub(crate) fn failure_message(failure: AuthFailure) -> String {
    let message = match failure {
        AuthFailure::Internal => "authentication service is unavailable",
        AuthFailure::Busy => "authentication service is busy",
        AuthFailure::InvalidRequest => "invalid authentication request",
        AuthFailure::UsernameTaken => "username is unavailable",
        AuthFailure::InvalidCredentials => "invalid credentials",
    };
    format!("{message}{NEGATIVE}")
}

pub(crate) fn negative(message: &str) -> String {
    format!("{message}{NEGATIVE}")
}

fn is_cookie_secure() -> bool {
    std::env::var("COOKIE_SECURE")
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true)
}

fn password_hasher() -> Argon2<'static> {
    let params =
        Params::new(19 * 1024, 2, 1, None).expect("argon2 parameters are invalid... /ᐠ - ˕ -マ");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub(crate) fn hash_password(password: &str) -> Result<String, AuthFailure> {
    let salt = SaltString::generate(&mut OsRng);
    password_hasher()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| AuthFailure::Internal)
}

#[derive(Clone, Copy)]
struct PasswordCheck {
    valid: bool,
    needs_upgrade: bool,
}

fn verify_password(password: &str, encoded: &str) -> PasswordCheck {
    if encoded.starts_with("$argon2id$") {
        let valid = PasswordHash::new(encoded).ok().is_some_and(|hash| {
            password_hasher()
                .verify_password(password.as_bytes(), &hash)
                .is_ok()
        });
        return PasswordCheck {
            valid,
            needs_upgrade: false,
        };
    }
    let valid = encoded.starts_with("$2") && bcrypt::verify(password, encoded).unwrap_or(false);
    PasswordCheck {
        valid,
        needs_upgrade: valid,
    }
}

fn dummy_password_hash() -> &'static str {
    static HASH: OnceLock<String> = OnceLock::new();
    HASH.get_or_init(|| {
        hash_password("not a real lyra password").expect("dummy password hash failed... /ᐠ - ˕ -マ")
    })
}

pub fn warm_password_verifier() {
    let _ = dummy_password_hash();
}

pub(crate) fn valid_username(username: &str) -> bool {
    (3..=20).contains(&username.len())
        && username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn session_cookie(value: String, max_age: Duration) -> Cookie<'static> {
    build_session_cookie(value, max_age, is_cookie_secure())
}

fn build_session_cookie(value: String, max_age: Duration, secure: bool) -> Cookie<'static> {
    Cookie::build((COOKIE_NAME, value))
        .path("/")
        .http_only(true)
        .secure(secure)
        .same_site(if secure {
            SameSite::Strict
        } else {
            SameSite::Lax
        })
        .max_age(max_age)
        .build()
}

#[derive(Clone)]
pub(crate) struct AppState {
    pub jwt_secret: Zeroizing<String>,
    pub pool: crate::db::DbPool,
    pub aes_cipher: Arc<Aes256Gcm>,
    pub auth_work: Arc<AdaptiveGate>,
    pub sync_work: Arc<AdaptiveGate>,
    pub sync_admission: Arc<crate::admission::Admission>,
    pub opaque_setup: Arc<opaque_ke::ServerSetup<crate::opaque::Suite>>,
}

#[derive(Serialize, Deserialize)]
struct Claims {
    id: i64,
    username: String,
    v: i64,
    exp: usize,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct UsernameQuery {
    pub name: String,
}

#[derive(Serialize)]
struct UsernameAvailability {
    available: bool,
}

#[derive(Serialize)]
pub(crate) struct UserResponse {
    pub id: i64,
    pub username: String,
    pub sync_salt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
}

const SYNC_SALT_BYTES: usize = 16;

pub(crate) fn new_sync_salt() -> Vec<u8> {
    use argon2::password_hash::rand_core::RngCore;
    let mut salt = vec![0; SYNC_SALT_BYTES];
    OsRng.fill_bytes(&mut salt);
    salt
}

pub(crate) fn sync_salt(
    connection: &rusqlite::Connection,
    user_id: i64,
) -> rusqlite::Result<String> {
    connection.execute(
        "UPDATE users SET sync_salt = ? WHERE id = ? AND sync_salt IS NULL",
        params![new_sync_salt(), user_id],
    )?;
    let salt: Vec<u8> = connection.query_row(
        "SELECT sync_salt FROM users WHERE id = ?",
        params![user_id],
        |row| row.get(0),
    )?;
    Ok(STANDARD.encode(salt))
}

pub(crate) fn account_created_at(
    connection: &rusqlite::Connection,
    user_id: i64,
) -> rusqlite::Result<Option<i64>> {
    let seconds: Option<i64> = connection.query_row(
        "SELECT CAST(strftime('%s', created_at) AS INTEGER) FROM users WHERE id = ?",
        params![user_id],
        |row| row.get(0),
    )?;
    Ok(seconds.map(|seconds| seconds * 1000))
}

#[derive(Serialize)]
pub(crate) struct AuthResponse {
    success: bool,
    user: Option<UserResponse>,
    error: Option<String>,
}

pub(crate) type AuthReply = (StatusCode, Json<AuthResponse>);

pub(crate) fn auth_success(status: StatusCode, user: Option<UserResponse>) -> AuthReply {
    (
        status,
        Json(AuthResponse {
            success: true,
            user,
            error: None,
        }),
    )
}

pub(crate) fn auth_error(status: StatusCode, error: String) -> AuthReply {
    (
        status,
        Json(AuthResponse {
            success: false,
            user: None,
            error: Some(error),
        }),
    )
}

pub(crate) fn session_token(
    state: &AppState,
    id: i64,
    username: &str,
    token_version: i64,
    issued_at: time::OffsetDateTime,
) -> Result<String, AuthFailure> {
    let claims = Claims {
        id,
        username: username.to_owned(),
        v: token_version,
        exp: (issued_at + Duration::days(SESSION_DAYS)).unix_timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
    .map_err(|_| AuthFailure::Internal)
}

pub(crate) fn start_session(
    state: &AppState,
    cookies: &Cookies,
    id: i64,
    username: &str,
    token_version: i64,
) -> Result<(), AuthFailure> {
    let token = session_token(
        state,
        id,
        username,
        token_version,
        time::OffsetDateTime::now_utc(),
    )?;
    cookies.add(session_cookie(token, Duration::days(SESSION_DAYS)));
    Ok(())
}

pub async fn username_available(
    State(state): State<Arc<AppState>>,
    query: Result<Query<UsernameQuery>, QueryRejection>,
) -> axum::response::Response {
    let name = match query {
        Ok(Query(UsernameQuery { name })) if valid_username(&name) => name,
        _ => {
            return auth_error(
                StatusCode::BAD_REQUEST,
                failure_message(AuthFailure::InvalidRequest),
            )
            .into_response()
        }
    };
    let pool = state.pool.clone();
    let taken = tokio::task::spawn_blocking(move || {
        let connection = pool.get().map_err(|_| AuthFailure::Internal)?;
        connection
            .query_row(
                "SELECT 1 FROM users WHERE username = ?",
                params![name],
                |_row: &rusqlite::Row| Ok(true),
            )
            .or_else(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                _ => Err(AuthFailure::Internal),
            })
    })
    .await
    .unwrap_or(Err(AuthFailure::Internal));
    match taken {
        Ok(taken) => Json(UsernameAvailability { available: !taken }).into_response(),
        Err(failure) => {
            auth_error(StatusCode::INTERNAL_SERVER_ERROR, failure_message(failure)).into_response()
        }
    }
}

enum LegacyLogin {
    Locked(u64),
    Verified(i64, i64, String),
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    payload: Result<Json<LoginRequest>, JsonRejection>,
) -> axum::response::Response {
    let Json(LoginRequest { username, password }) = match payload {
        Ok(payload) => payload,
        Err(rejection) => {
            return auth_error(
                rejection.status(),
                failure_message(AuthFailure::InvalidRequest),
            )
            .into_response()
        }
    };
    let password = Zeroizing::new(password);
    if !valid_username(&username)
        || password.is_empty()
        || password.chars().count() > MAX_PASSWORD_CHARS
    {
        return auth_error(
            StatusCode::BAD_REQUEST,
            failure_message(AuthFailure::InvalidCredentials),
        )
        .into_response();
    }

    let Some(permit) = state.auth_work.try_acquire() else {
        return auth_error(
            StatusCode::SERVICE_UNAVAILABLE,
            failure_message(AuthFailure::Busy),
        )
        .into_response();
    };

    let pool = state.pool.clone();
    let stored_username = username.clone();
    let now = time::OffsetDateTime::now_utc().unix_timestamp();

    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let (id, password_hash, token_version) = {
            let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
            let row: Result<(i64, String, i64, bool), rusqlite::Error> = conn.query_row(
                "SELECT id, password_hash, token_version, opaque_record IS NOT NULL FROM users WHERE username = ?",
                params![stored_username],
                |row: &rusqlite::Row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            );
            match row {
                Ok((id, password_hash, token_version, false)) => {
                    if let Attempt::Locked { retry_after } =
                        count_attempt(&conn, id, now).map_err(|_| AuthFailure::Internal)?
                    {
                        return Ok(LegacyLogin::Locked(retry_after));
                    }
                    (id, password_hash, token_version)
                }
                Ok(_) | Err(rusqlite::Error::QueryReturnedNoRows) => {
                    let _ = verify_password(&password, dummy_password_hash());
                    return Err(AuthFailure::InvalidCredentials);
                }
                Err(_) => return Err(AuthFailure::Internal),
            }
        };

        let check = verify_password(&password, &password_hash);
        if !check.valid {
            return Err(AuthFailure::InvalidCredentials);
        }
        let conn = pool.get().map_err(|_| AuthFailure::Internal)?;
        reset_attempts(&conn, id).map_err(|_| AuthFailure::Internal)?;
        if check.needs_upgrade {
            let upgraded = hash_password(&password)?;
            conn.execute(
                "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?",
                params![upgraded, id, password_hash],
            )
            .map_err(|_| AuthFailure::Internal)?;
        }
        let sync_salt = sync_salt(&conn, id).map_err(|_| AuthFailure::Internal)?;

        Ok(LegacyLogin::Verified(id, token_version, sync_salt))
    })
    .await;

    match result {
        Ok(Ok(LegacyLogin::Verified(id, token_version, sync_salt))) => {
            match start_session(&state, &cookies, id, &username, token_version) {
                Ok(()) => auth_success(
                    StatusCode::OK,
                    Some(UserResponse {
                        id,
                        username,
                        sync_salt,
                        created_at: None,
                    }),
                )
                .into_response(),
                Err(failure) => {
                    auth_error(StatusCode::INTERNAL_SERVER_ERROR, failure_message(failure))
                        .into_response()
                }
            }
        }
        Ok(Ok(LegacyLogin::Locked(retry_after))) => too_many_attempts(retry_after),
        Ok(Err(failure)) => {
            auth_error(StatusCode::UNAUTHORIZED, failure_message(failure)).into_response()
        }
        Err(_) => auth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            failure_message(AuthFailure::Internal),
        )
        .into_response(),
    }
}

pub async fn logout(State(state): State<Arc<AppState>>, cookies: Cookies) -> impl IntoResponse {
    if let Ok((user_id, _)) = get_current_user(&state, &cookies).await {
        let pool = state.pool.clone();
        let revoked = tokio::task::spawn_blocking(move || {
            let connection = pool.get().map_err(|_| AuthFailure::Internal)?;
            connection
                .execute(
                    "UPDATE users SET token_version = token_version + 1 WHERE id = ?",
                    params![user_id],
                )
                .map_err(|_| AuthFailure::Internal)?;
            Ok::<(), AuthFailure>(())
        })
        .await;
        if !matches!(revoked, Ok(Ok(()))) {
            return auth_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                failure_message(AuthFailure::Internal),
            );
        }
        cached_token_invalidate(user_id);
    }
    cookies.add(session_cookie(String::new(), Duration::seconds(0)));
    auth_success(StatusCode::OK, None)
}

pub async fn me(State(state): State<Arc<AppState>>, cookies: Cookies) -> impl IntoResponse {
    let Ok((id, username)) = get_current_user(&state, &cookies).await else {
        return auth_error(StatusCode::UNAUTHORIZED, negative("unauthorized"));
    };
    let pool = state.pool.clone();
    let account = tokio::task::spawn_blocking(move || {
        let connection = pool.get().map_err(|_| AuthFailure::Internal)?;
        let salt = sync_salt(&connection, id).map_err(|_| AuthFailure::Internal)?;
        let created_at = account_created_at(&connection, id).map_err(|_| AuthFailure::Internal)?;
        Ok::<_, AuthFailure>((salt, created_at))
    })
    .await;
    match account {
        Ok(Ok((sync_salt, created_at))) => auth_success(
            StatusCode::OK,
            Some(UserResponse {
                id,
                username,
                sync_salt,
                created_at,
            }),
        ),
        _ => auth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            failure_message(AuthFailure::Internal),
        ),
    }
}

pub async fn metrics(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let gate = |snapshot: adaptive_capacity::GateSnapshot| {
        serde_json::json!({
            "active": snapshot.active,
            "limit": snapshot.limit,
            "minimum": snapshot.minimum,
            "maximum": snapshot.maximum,
            "peak": snapshot.peak,
            "waits": snapshot.waits,
            "rejected": snapshot.rejected,
        })
    };
    Json(serde_json::json!({
        "transfer": state.sync_admission.metrics(),
        "storage": crate::sync::transfer::metrics(),
        "auth": gate(state.auth_work.snapshot()),
        "sync": gate(state.sync_work.snapshot()),
    }))
}

pub async fn delete_account(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
) -> impl IntoResponse {
    let Ok((user_id, _)) = get_current_user(&state, &cookies).await else {
        return auth_error(StatusCode::UNAUTHORIZED, negative("unauthorized"));
    };

    let pool = state.pool.clone();
    let delete_result = tokio::task::spawn_blocking(move || {
        let connection = pool.get().map_err(|_| AuthFailure::Internal)?;
        connection
            .execute("DELETE FROM users WHERE id = ?", params![user_id])
            .map_err(|_| AuthFailure::Internal)?;
        if connection
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                row.get::<_, i64>(0)
            })
            .is_ok_and(|busy| busy != 0)
        {
            tracing::debug!("deleted account pages wait for the next checkpoint");
        }
        Ok::<(), AuthFailure>(())
    })
    .await;
    if !matches!(delete_result, Ok(Ok(()))) {
        return auth_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            failure_message(AuthFailure::Internal),
        );
    }

    crate::sync::cached_meta_invalidate(user_id);
    cached_token_invalidate(user_id);
    cookies.add(session_cookie(String::new(), Duration::seconds(0)));
    auth_success(StatusCode::OK, None)
}

static TOKEN_CACHE: OnceLock<DashMap<i64, (i64, Instant)>> = OnceLock::new();

fn get_token_cache() -> &'static DashMap<i64, (i64, Instant)> {
    TOKEN_CACHE.get_or_init(DashMap::new)
}

fn cached_token_invalidate(user_id: i64) {
    get_token_cache().remove(&user_id);
}

pub(crate) async fn get_current_user(
    state: &AppState,
    cookies: &Cookies,
) -> Result<(i64, String), ()> {
    current_session(state, cookies)
        .await
        .map(|(id, username, _)| (id, username))
}

pub(crate) async fn get_recent_user(
    state: &AppState,
    cookies: &Cookies,
    max_age_secs: i64,
) -> Result<(i64, String), ()> {
    let (id, username, exp) = current_session(state, cookies).await?;
    let issued_at = i64::try_from(exp)
        .map_err(|_| ())?
        .checked_sub(Duration::days(SESSION_DAYS).whole_seconds())
        .ok_or(())?;
    let age = time::OffsetDateTime::now_utc().unix_timestamp() - issued_at;
    if age > max_age_secs {
        return Err(());
    }
    Ok((id, username))
}

async fn current_session(state: &AppState, cookies: &Cookies) -> Result<(i64, String, usize), ()> {
    let token_cookie = cookies.get(COOKIE_NAME).ok_or(())?;
    let token = token_cookie.value();

    let mut validation = Validation::new(JwtAlgorithm::HS256);
    validation.required_spec_claims.insert("exp".into());
    let token_data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|_| ())?;

    let user_id = token_data.claims.id;
    let token_v = token_data.claims.v;

    let cache = get_token_cache();
    if let Some(entry) = cache.get(&user_id) {
        let (cached_v, cached_at) = *entry;
        if cached_at.elapsed().as_secs() < TOKEN_CACHE_TTL_SECS {
            if cached_v != token_v {
                return Err(());
            }
            return Ok((user_id, token_data.claims.username, token_data.claims.exp));
        }
    }

    let pool = state.pool.clone();
    let db_v = tokio::task::spawn_blocking(move || {
        let conn = pool.get().map_err(|_| ())?;
        let (db_version,): (i64,) = conn
            .query_row(
                "SELECT token_version FROM users WHERE id = ?",
                params![user_id],
                |row: &rusqlite::Row| Ok((row.get(0)?,)),
            )
            .map_err(|_| ())?;
        Ok(db_version)
    })
    .await
    .map_err(|_| ())??;

    if cache.len() >= TOKEN_CACHE_MAX_ENTRIES {
        let evicted = cache.iter().next().map(|entry| *entry.key());
        if let Some(user_id) = evicted {
            cache.remove(&user_id);
        }
    }
    cache.insert(user_id, (db_v, Instant::now()));

    if db_v != token_v {
        return Err(());
    }

    Ok((
        token_data.claims.id,
        token_data.claims.username,
        token_data.claims.exp,
    ))
}

