use super::*;
use crate::admission::ACCOUNT_CHUNK_LIMIT;
use axum::body::{to_bytes, Body};
use axum::extract::{rejection::PathRejection, Path, Request};
use axum::http::header::{ACCEPT_ENCODING, VARY};
use axum::http::HeaderValue;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use std::io::Cursor;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

pub const CHUNK_SIZE: usize = 1024 * 1024;
const MAX_PARTS: i64 = (MAX_RAW_SIZE / CHUNK_SIZE) as i64;
const MAX_SEALED_PARTS: i64 = 4096;
const MAX_SEAL_LENGTH: usize = 512;
const UPLOAD_CONCURRENCY: u8 = 4;
const MANIFEST_MAGIC: &[u8] = b"wcs2";
static UPLOADED_BYTES: AtomicU64 = AtomicU64::new(0);
static REUSED_BYTES: AtomicU64 = AtomicU64::new(0);

pub fn metrics() -> Value {
    serde_json::json!({"uploaded_bytes": UPLOADED_BYTES.load(Ordering::Relaxed), "reused_bytes": REUSED_BYTES.load(Ordering::Relaxed)})
}

pub(super) fn manifest_id(blob: &[u8]) -> Option<&str> {
    let id = std::str::from_utf8(blob.strip_prefix(MANIFEST_MAGIC)?).ok()?;
    (id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())).then_some(id)
}

impl From<rusqlite::Error> for SyncError {
    fn from(error: rusqlite::Error) -> Self {
        if matches!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        ) {
            Self::Busy
        } else {
            Self::Internal
        }
    }
}

fn collect_objects(connection: &Connection, user_id: i64) -> rusqlite::Result<usize> {
    connection.execute("DELETE FROM sync_objects WHERE user_id = ? AND NOT EXISTS (SELECT 1 FROM sync_chunk_refs r WHERE r.user_id = sync_objects.user_id AND r.digest = sync_objects.digest)", [user_id])
}

pub fn cleanup(connection: &Connection) -> rusqlite::Result<usize> {
    let users: Vec<i64> = connection.prepare("SELECT DISTINCT user_id FROM sync_uploads WHERE committed = 0 AND touched < unixepoch() - 86400 LIMIT 16")?
        .query_map([], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut deleted = 0;
    for user in users {
        deleted += connection.execute("DELETE FROM sync_uploads WHERE user_id = ? AND committed = 0 AND touched < unixepoch() - 86400", [user])?;
        collect_objects(connection, user)?;
    }
    Ok(deleted)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Upload {
    parts: i64,
    committed: bool,
    sealed: bool,
}

fn upload_info(connection: &Connection, user_id: i64, id: &str) -> SyncResult<Upload> {
    connection
        .query_row(
            "SELECT parts, committed, sealed FROM sync_uploads WHERE id = ? AND user_id = ?",
            params![id, user_id],
            |row| {
                Ok(Upload {
                    parts: row.get(0)?,
                    committed: row.get(1)?,
                    sealed: row.get(2)?,
                })
            },
        )
        .optional()?
        .ok_or(SyncError::Conflict)
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_seal(seal: &str) -> bool {
    (1..=MAX_SEAL_LENGTH).contains(&seal.len())
        && seal.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

fn begin_with_hashes(
    connection: &mut Connection,
    user_id: i64,
    parts: i64,
    hashes: Option<&[String]>,
    sealed: bool,
) -> SyncResult<(String, Vec<i64>)> {
    if parts <= 0 || (sealed && hashes.is_none()) {
        return Err(SyncError::InvalidPayload);
    }
    if parts > if sealed { MAX_SEALED_PARTS } else { MAX_PARTS } {
        return Err(SyncError::TooLarge);
    }
    if hashes.is_some_and(|hashes| {
        hashes.len() != parts as usize || hashes.iter().any(|hash| !valid_digest(hash))
    }) {
        return Err(SyncError::InvalidPayload);
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "DELETE FROM sync_uploads WHERE user_id = ? AND committed = 0",
        [user_id],
    )?;
    let id: String = transaction.query_row("INSERT INTO sync_uploads (id, user_id, parts, sealed) VALUES (lower(hex(randomblob(16))), ?, ?, ?) RETURNING id", params![user_id, parts, sealed], |row| row.get(0))?;
    let mut missing = Vec::new();
    let mut reused = 0;
    for part in 0..parts {
        let bytes = if let Some(hashes) = hashes {
            let digest = &hashes[part as usize];
            let bytes: Option<u64> = transaction
                .query_row(
                    "SELECT raw_bytes FROM sync_objects WHERE user_id = ? AND digest = ? AND sealed = ?",
                    params![user_id, digest, sealed],
                    |row| row.get(0),
                )
                .optional()?;
            if bytes.is_some() {
                transaction.execute(
                    "INSERT INTO sync_chunk_refs VALUES (?, ?, ?, ?)",
                    params![id, part, user_id, digest],
                )?;
            } else if sealed {
                transaction.execute(
                    "INSERT INTO sync_upload_digests VALUES (?, ?, ?)",
                    params![id, part, digest],
                )?;
            }
            bytes
        } else {
            None
        };
        if let Some(bytes) = bytes {
            reused += bytes;
        } else {
            missing.push(part);
        }
    }
    collect_objects(&transaction, user_id)?;
    transaction.commit()?;
    REUSED_BYTES.fetch_add(reused, Ordering::Relaxed);
    Ok((id, missing))
}

fn chunk_aad(user_id: i64, id: &str, part: i64) -> String {
    format!("{user_id}:{id}:{part}")
}
fn object_aad(user_id: i64, digest: &str) -> String {
    format!("wcs3:{user_id}:{digest}")
}
fn sealed_object_aad(user_id: i64, digest: &str) -> String {
    format!("wcs4:{user_id}:{digest}")
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn encrypt_chunk(cipher: &Aes256Gcm, bytes: &[u8], aad: &str) -> SyncResult<Vec<u8>> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: bytes,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SyncError::Internal)?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&encrypted);
    Ok(blob)
}

fn decrypt_chunk(cipher: &Aes256Gcm, blob: &[u8], aad: &str) -> SyncResult<Vec<u8>> {
    if blob.len() < IV_LENGTH {
        return Err(SyncError::Corrupt);
    }
    cipher
        .decrypt(
            Nonce::from_slice(&blob[..IV_LENGTH]),
            Payload {
                msg: &blob[IV_LENGTH..],
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| SyncError::Corrupt)
}

fn decode_chunk(cipher: &Aes256Gcm, blob: &[u8], aad: &str) -> SyncResult<Vec<u8>> {
    decompress_chunk(&decrypt_chunk(cipher, blob, aad)?)
}

fn decompress_chunk(compressed: &[u8]) -> SyncResult<Vec<u8>> {
    let mut bytes = Vec::new();
    brotli::Decompressor::new(compressed, 64 * 1024)
        .take((CHUNK_SIZE + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| SyncError::Corrupt)?;
    if bytes.is_empty() || bytes.len() > CHUNK_SIZE {
        return Err(SyncError::Corrupt);
    }
    Ok(bytes)
}

fn read_chunk(
    connection: &Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    part: i64,
) -> SyncResult<Vec<u8>> {
    read_chunk_encoded(connection, cipher, user_id, id, part, false).map(|(bytes, _)| bytes)
}

fn read_chunk_encoded(
    connection: &Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    part: i64,
    brotli: bool,
) -> SyncResult<(Vec<u8>, bool)> {
    let object: Option<(String, Vec<u8>, bool)> = connection.query_row("SELECT r.digest, o.data_blob, o.sealed FROM sync_chunk_refs r JOIN sync_objects o ON o.user_id = r.user_id AND o.digest = r.digest WHERE r.upload_id = ? AND r.part = ? AND r.user_id = ?", params![id, part, user_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).optional()?;
    if let Some((hash, blob, sealed)) = object {
        if sealed {
            let bytes = decrypt_chunk(cipher, &blob, &sealed_object_aad(user_id, &hash))?;
            if bytes.is_empty() || bytes.len() > CHUNK_SIZE {
                return Err(SyncError::Corrupt);
            }
            return Ok((bytes, false));
        }
        let compressed = decrypt_chunk(cipher, &blob, &object_aad(user_id, &hash))?;
        let bytes = decompress_chunk(&compressed)?;
        if digest(&bytes) != hash {
            return Err(SyncError::Corrupt);
        }
        return Ok(if brotli {
            (compressed, true)
        } else {
            (bytes, false)
        });
    }
    let blob: Vec<u8> = connection
        .query_row(
            "SELECT data_blob FROM sync_chunks WHERE upload_id = ? AND part = ?",
            params![id, part],
            |row| row.get(0),
        )
        .optional()?
        .ok_or(SyncError::Conflict)?;
    Ok((
        decode_chunk(cipher, &blob, &chunk_aad(user_id, id, part))?,
        false,
    ))
}

fn accepts_brotli(headers: &HeaderMap) -> bool {
    headers
        .get_all(ACCEPT_ENCODING)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|entry| {
            let mut parts = entry.split(';');
            parts
                .next()
                .is_some_and(|coding| coding.trim().eq_ignore_ascii_case("br"))
                && parts.all(|parameter| {
                    parameter
                        .trim()
                        .strip_prefix("q=")
                        .is_none_or(|quality| quality.trim().parse::<f32>().is_ok_and(|q| q > 0.0))
                })
        })
}

fn chunk_exists(connection: &Connection, id: &str, part: i64) -> SyncResult<bool> {
    Ok(connection.query_row("SELECT EXISTS(SELECT 1 FROM sync_chunks WHERE upload_id = ?1 AND part = ?2 UNION ALL SELECT 1 FROM sync_chunk_refs WHERE upload_id = ?1 AND part = ?2)", params![id, part], |row| row.get(0))?)
}

fn write_sealed_chunk(
    connection: &mut Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    part: i64,
    bytes: &[u8],
) -> SyncResult<()> {
    let declared: Option<String> = connection
        .query_row(
            "SELECT digest FROM sync_upload_digests WHERE upload_id = ? AND part = ?",
            params![id, part],
            |row| row.get(0),
        )
        .optional()?;
    let Some(hash) = declared else {
        return if chunk_exists(connection, id, part)? {
            Ok(())
        } else {
            Err(SyncError::InvalidPayload)
        };
    };
    let blob = encrypt_chunk(cipher, bytes, &sealed_object_aad(user_id, &hash))?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let upload = upload_info(&transaction, user_id, id)?;
    if !chunk_exists(&transaction, id, part)? {
        if upload.committed {
            return Err(SyncError::Conflict);
        }
        transaction.execute(
            "INSERT OR IGNORE INTO sync_objects (user_id, digest, raw_bytes, data_blob, sealed) VALUES (?, ?, ?, ?, 1)",
            params![user_id, hash, bytes.len(), blob],
        )?;
        transaction.execute(
            "INSERT INTO sync_chunk_refs VALUES (?, ?, ?, ?)",
            params![id, part, user_id, hash],
        )?;
    }
    transaction.execute(
        "UPDATE sync_uploads SET touched = unixepoch() WHERE id = ?",
        [id],
    )?;
    transaction.commit()?;
    UPLOADED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    Ok(())
}

fn write_chunk(
    connection: &mut Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    part: i64,
    bytes: &[u8],
) -> SyncResult<()> {
    if bytes.is_empty() || bytes.len() > CHUNK_SIZE {
        return Err(SyncError::TooLarge);
    }
    let upload = upload_info(connection, user_id, id)?;
    if upload.parts
        > if upload.sealed {
            MAX_SEALED_PARTS
        } else {
            MAX_PARTS
        }
    {
        return Err(SyncError::TooLarge);
    }
    if part < 0 || part >= upload.parts {
        return Err(SyncError::InvalidPayload);
    }
    if upload.sealed {
        return write_sealed_chunk(connection, cipher, user_id, id, part, bytes);
    }
    let hash = digest(bytes);
    let mut compressor = brotli::CompressorWriter::new(Vec::new(), 64 * 1024, 3, 22);
    compressor
        .write_all(bytes)
        .map_err(|_| SyncError::Internal)?;
    let blob = encrypt_chunk(
        cipher,
        &compressor.into_inner(),
        &object_aad(user_id, &hash),
    )?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let upload = upload_info(&transaction, user_id, id)?;
    if chunk_exists(&transaction, id, part)? {
        if read_chunk(&transaction, cipher, user_id, id, part)? != bytes {
            return Err(SyncError::Conflict);
        }
    } else {
        if upload.committed {
            return Err(SyncError::Conflict);
        }
        transaction.execute(
            "INSERT OR IGNORE INTO sync_objects (user_id, digest, raw_bytes, data_blob, sealed) VALUES (?, ?, ?, ?, 0)",
            params![user_id, hash, bytes.len(), blob],
        )?;
        transaction.execute(
            "INSERT INTO sync_chunk_refs VALUES (?, ?, ?, ?)",
            params![id, part, user_id, hash],
        )?;
    }
    transaction.execute(
        "UPDATE sync_uploads SET touched = unixepoch() WHERE id = ?",
        [id],
    )?;
    transaction.commit()?;
    UPLOADED_BYTES.fetch_add(bytes.len() as u64, Ordering::Relaxed);
    Ok(())
}

struct ChunkReader<'a> {
    connection: &'a Connection,
    cipher: &'a Aes256Gcm,
    user_id: i64,
    id: &'a str,
    next: i64,
    parts: i64,
    current: Cursor<Vec<u8>>,
}
impl Read for ChunkReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.current.position() == self.current.get_ref().len() as u64 && self.next < self.parts
        {
            self.current = Cursor::new(
                read_chunk(
                    self.connection,
                    self.cipher,
                    self.user_id,
                    self.id,
                    self.next,
                )
                .map_err(|_| std::io::Error::other("sync chunk is unavailable... /ᐠ - ˕ -マ"))?,
            );
            self.next += 1;
        }
        self.current.read(buffer)
    }
}

fn stored_parts(connection: &Connection, id: &str) -> SyncResult<i64> {
    Ok(connection.query_row("SELECT (SELECT count(*) FROM sync_chunks WHERE upload_id = ?1) + (SELECT count(*) FROM sync_chunk_refs WHERE upload_id = ?1)", [id], |row| row.get(0))?)
}

pub(super) fn load_snapshot(
    connection: &Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
) -> SyncResult<Snapshot> {
    let upload = upload_info(connection, user_id, id)?;
    if upload.sealed {
        return Err(SyncError::Sealed);
    }
    if upload.parts > MAX_PARTS {
        return Err(SyncError::TooLarge);
    }
    if stored_parts(connection, id)? != upload.parts {
        return Err(SyncError::Conflict);
    }
    let reader = ChunkReader {
        connection,
        cipher,
        user_id,
        id,
        next: 0,
        parts: upload.parts,
        current: Cursor::new(Vec::new()),
    };
    let snapshot: Snapshot =
        serde_json::from_reader(std::io::BufReader::new(reader.take(MAX_RAW_SIZE as u64)))
            .map_err(|_| SyncError::Unprocessable)?;
    validate_decoded_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn verify_sealed(connection: &Connection, id: &str, upload: Upload) -> SyncResult<()> {
    if stored_parts(connection, id)? != upload.parts {
        return Err(SyncError::Conflict);
    }
    let stored: i64 = connection.query_row(
        "SELECT coalesce(sum(o.raw_bytes), 0) FROM sync_chunk_refs r JOIN sync_objects o ON o.user_id = r.user_id AND o.digest = r.digest WHERE r.upload_id = ?",
        [id],
        |row| row.get(0),
    )?;
    if stored as usize > MAX_RAW_SIZE {
        return Err(SyncError::TooLarge);
    }
    Ok(())
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Commit {
    base: Option<String>,
    seal: Option<String>,
}

pub(super) fn active_is_sealed(connection: &Connection, user_id: i64) -> SyncResult<bool> {
    let blob: Option<Vec<u8>> = connection
        .query_row(
            "SELECT substr(data_blob, 1, 36) FROM sync_data WHERE user_id = ?",
            [user_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(id) = blob.as_deref().and_then(manifest_id) else {
        return Ok(false);
    };
    Ok(upload_info(connection, user_id, id).is_ok_and(|upload| upload.sealed))
}

fn commit_upload(
    connection: &mut Connection,
    cipher: &Aes256Gcm,
    user_id: i64,
    id: &str,
    request: &Commit,
) -> SyncResult<String> {
    let upload = upload_info(connection, user_id, id)?;
    if !upload.committed {
        if upload.sealed {
            if !request.seal.as_deref().is_some_and(valid_seal) {
                return Err(SyncError::InvalidPayload);
            }
            verify_sealed(connection, id, upload)?;
        } else {
            drop(load_snapshot(connection, cipher, user_id, id)?);
        }
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if !upload_info(&transaction, user_id, id)?.committed {
        if !upload.sealed && active_is_sealed(&transaction, user_id)? {
            return Err(SyncError::Sealed);
        }
        if let Some(base) = &request.base {
            let current: Option<String> = transaction
                .query_row(
                    "SELECT updated_at FROM sync_data WHERE user_id = ?",
                    [user_id],
                    |row| row.get(0),
                )
                .optional()?;
            if current.as_deref().unwrap_or("") != base {
                return Err(SyncError::RevisionConflict);
            }
        }
        let mut manifest = MANIFEST_MAGIC.to_vec();
        manifest.extend_from_slice(id.as_bytes());
        transaction.execute("INSERT INTO sync_data (user_id, data_blob, updated_at) VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') || '-' || LOWER(HEX(RANDOMBLOB(8)))) ON CONFLICT(user_id) DO UPDATE SET data_blob = excluded.data_blob, updated_at = excluded.updated_at", params![user_id, manifest])?;
        transaction.execute(
            "UPDATE sync_uploads SET committed = 1, seal = ? WHERE id = ?",
            params![request.seal.as_deref().filter(|_| upload.sealed), id],
        )?;
        transaction.execute(
            "DELETE FROM sync_uploads WHERE user_id = ? AND id != ?",
            params![user_id, id],
        )?;
        transaction.execute("DELETE FROM sync_upload_digests WHERE upload_id = ?", [id])?;
        collect_objects(&transaction, user_id)?;
    }
    let updated_at = transaction.query_row(
        "SELECT updated_at FROM sync_data WHERE user_id = ?",
        [user_id],
        |row| row.get(0),
    )?;
    transaction.commit()?;
    Ok(updated_at)
}

async fn run(
    state: Arc<AppState>,
    cookies: Cookies,
    operation: Operation,
    body: Option<(Body, usize)>,
    work: impl FnOnce(&mut Connection, &Aes256Gcm, i64, Bytes) -> SyncResult<Response> + Send + 'static,
) -> Response {
    let (user_id, _) = match get_current_user(&state, &cookies).await {
        Ok(user) => user,
        Err(()) => return response(false, None, None, Some(SyncError::Unauthorized)),
    };
    let Some(permit) = state
        .sync_admission
        .acquire(user_id, operation, &state.sync_work)
        .await
    else {
        return response(false, None, None, Some(SyncError::Busy));
    };
    let bytes = match body {
        Some((body, limit)) => {
            match tokio::time::timeout(Duration::from_secs(15), to_bytes(body, limit)).await {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(_)) => return response(false, None, None, Some(SyncError::TooLarge)),
                Err(_) => return response(false, None, None, Some(SyncError::Busy)),
            }
        }
        None => Bytes::new(),
    };
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        let mut connection = state.pool.get().map_err(|_| SyncError::Busy)?;
        work(&mut connection, &state.aes_cipher, user_id, bytes)
    })
    .await
    .unwrap_or(Err(SyncError::Internal));
    result.unwrap_or_else(|error| response(false, None, None, Some(error)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    parts: i64,
    hashes: Option<Vec<String>>,
    #[serde(default)]
    sealed: bool,
}

pub async fn begin(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    request: Request,
) -> Response {
    run(state, cookies, Operation::Write, Some((request.into_body(), 512 * 1024)), move |connection, _, user_id, bytes| {
        let request: Start = serde_json::from_slice(&bytes).map_err(|_| SyncError::InvalidPayload)?;
        let (id, missing) = begin_with_hashes(connection, user_id, request.parts, request.hashes.as_deref(), request.sealed)?;
        let max_parts = if request.sealed { MAX_SEALED_PARTS } else { MAX_PARTS };
        Ok(Json(serde_json::json!({"id": id, "chunk_size": CHUNK_SIZE, "missing": missing, "concurrency": UPLOAD_CONCURRENCY, "max_bytes": MAX_RAW_SIZE, "max_parts": max_parts})).into_response())
    }).await
}

pub async fn put(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    path: Result<Path<(String, i64)>, PathRejection>,
    request: Request,
) -> Response {
    let (headers, body) = request.into_parts();
    run(
        state,
        cookies,
        Operation::Write,
        Some((body, CHUNK_SIZE)),
        move |connection, cipher, user_id, bytes| {
            let Path((id, part)) = path.map_err(|_| SyncError::InvalidPayload)?;
            let encoding = headers
                .headers
                .get(CONTENT_ENCODING)
                .map(|value| value.to_str().map_err(|_| SyncError::UnsupportedEncoding))
                .transpose()?
                .unwrap_or("identity");
            let decoded;
            let bytes = if encoding.eq_ignore_ascii_case("gzip") {
                let mut buffer = Vec::new();
                flate2::read::GzDecoder::new(bytes.as_ref())
                    .take((CHUNK_SIZE + 1) as u64)
                    .read_to_end(&mut buffer)
                    .map_err(|_| SyncError::Unprocessable)?;
                decoded = buffer;
                decoded.as_slice()
            } else if encoding.eq_ignore_ascii_case("identity") {
                bytes.as_ref()
            } else {
                return Err(SyncError::UnsupportedEncoding);
            };
            write_chunk(connection, cipher, user_id, &id, part, bytes)?;
            Ok(response(true, None, None, None))
        },
    )
    .await
}

pub async fn commit(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    path: Result<Path<String>, PathRejection>,
    request: Request,
) -> Response {
    run(
        state,
        cookies,
        Operation::Snapshot,
        Some((request.into_body(), 4096)),
        move |connection, cipher, user_id, bytes| {
            let Path(id) = path.map_err(|_| SyncError::InvalidPayload)?;
            let request = if bytes.is_empty() {
                Commit::default()
            } else {
                serde_json::from_slice(&bytes).map_err(|_| SyncError::InvalidPayload)?
            };
            let updated_at = commit_upload(connection, cipher, user_id, &id, &request)?;
            cached_meta_set(user_id, updated_at.clone());
            Ok(response(true, None, Some(updated_at), None))
        },
    )
    .await
}

pub async fn manifest(State(state): State<Arc<AppState>>, cookies: Cookies) -> Response {
    run(state, cookies, Operation::Read, None, |connection, _, user_id, _| {
        let row: Option<(Vec<u8>, String)> = connection.query_row("SELECT substr(data_blob, 1, 36), updated_at FROM sync_data WHERE user_id = ?", [user_id], |row| Ok((row.get(0)?, row.get(1)?))).optional()?;
        let (blob, updated_at) = row.ok_or(SyncError::Missing)?;
        let Some(id) = manifest_id(&blob) else { return Ok(Json(serde_json::json!({"legacy": true, "updated_at": updated_at})).into_response()); };
        let upload = upload_info(connection, user_id, id)?;
        if !upload.committed { return Err(SyncError::Corrupt); }
        if !upload.sealed {
            return Ok(Json(serde_json::json!({"id": id, "parts": upload.parts, "updated_at": updated_at, "concurrency": ACCOUNT_CHUNK_LIMIT, "sealed": false})).into_response());
        }
        let seal: Option<String> = connection.query_row("SELECT seal FROM sync_uploads WHERE id = ?", [id], |row| row.get(0))?;
        let digests = connection
            .prepare("SELECT digest FROM sync_chunk_refs WHERE upload_id = ? ORDER BY part")?
            .query_map([id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if digests.len() as i64 != upload.parts { return Err(SyncError::Corrupt); }
        Ok(Json(serde_json::json!({"id": id, "parts": upload.parts, "updated_at": updated_at, "concurrency": ACCOUNT_CHUNK_LIMIT, "sealed": true, "seal": seal.ok_or(SyncError::Corrupt)?, "digests": digests})).into_response())
    }).await
}

pub async fn get(
    State(state): State<Arc<AppState>>,
    cookies: Cookies,
    headers: HeaderMap,
    path: Result<Path<(String, i64)>, PathRejection>,
) -> Response {
    let brotli = accepts_brotli(&headers);
    run(
        state,
        cookies,
        Operation::Read,
        None,
        move |connection, cipher, user_id, _| {
            let Path((id, part)) = path.map_err(|_| SyncError::InvalidPayload)?;
            let upload = upload_info(connection, user_id, &id)?;
            if !upload.committed || part < 0 || part >= upload.parts {
                return Err(SyncError::Conflict);
            }
            let (bytes, encoded) =
                read_chunk_encoded(connection, cipher, user_id, &id, part, brotli)?;
            let mut response =
                ([(CONTENT_TYPE, "application/octet-stream")], bytes).into_response();
            let response_headers = response.headers_mut();
            response_headers.insert(VARY, HeaderValue::from_static("accept-encoding"));
            if encoded {
                response_headers.insert(CONTENT_ENCODING, HeaderValue::from_static("br"));
            }
            Ok(response)
        },
    )
    .await
}

