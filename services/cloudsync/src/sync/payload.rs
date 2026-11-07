use super::*;

pub(super) struct LimitedWriter<W> {
    inner: W,
    written: usize,
    too_large: bool,
}

impl<W: Write> Write for LimitedWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if buffer.len() > MAX_RAW_SIZE.saturating_sub(self.written) {
            self.too_large = true;
            return Err(std::io::Error::other(
                "sync payload is too large... /ᐠ - ˕ -マ",
            ));
        }
        let written = self.inner.write(buffer)?;
        self.written += written;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

pub(super) fn compress_payload<T: Serialize + ?Sized>(payload: &T) -> SyncResult<Vec<u8>> {
    let compressor = brotli::CompressorWriter::new(Vec::new(), 64 * 1024, 3, 22);
    let mut writer = LimitedWriter {
        inner: compressor,
        written: 0,
        too_large: false,
    };
    if serde_json::to_writer(&mut writer, payload).is_err() {
        return Err(if writer.too_large {
            SyncError::TooLarge
        } else {
            SyncError::InvalidPayload
        });
    }
    writer.flush().map_err(|_| SyncError::Internal)?;
    Ok(writer.inner.into_inner())
}

pub(super) fn decompress_payload(compressed: &[u8]) -> SyncResult<Snapshot> {
    let decoder = brotli::Decompressor::new(compressed, 64 * 1024);
    let mut limited = decoder.take((MAX_DECOMPRESSED_SIZE + 1) as u64);
    let snapshot = serde_json::from_reader::<_, Snapshot>(&mut limited);
    if limited.limit() == 0 {
        return Err(SyncError::TooLarge);
    }
    let snapshot = snapshot.map_err(|_| SyncError::Corrupt)?;
    validate_decoded_snapshot(&snapshot).map_err(|_| SyncError::Corrupt)?;
    Ok(snapshot)
}

pub(super) fn encrypt_blob(
    cipher: &Aes256Gcm,
    user_id: i64,
    compressed: &[u8],
) -> SyncResult<Vec<u8>> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let aad = user_id.to_be_bytes();
    let encrypted = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: compressed,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Internal)?;
    let mut blob = Vec::with_capacity(BLOB_MAGIC.len() + IV_LENGTH + encrypted.len());
    blob.extend_from_slice(BLOB_MAGIC);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&encrypted);
    (blob.len() <= MAX_BLOB_SIZE)
        .then_some(blob)
        .ok_or(SyncError::TooLarge)
}

pub(super) fn decrypt_blob(
    cipher: &Aes256Gcm,
    user_id: i64,
    blob: &[u8],
) -> SyncResult<(Vec<u8>, bool)> {
    if blob.starts_with(BLOB_MAGIC) {
        if blob.len() < BLOB_MAGIC.len() + IV_LENGTH {
            return Err(SyncError::Corrupt);
        }
        let nonce_start = BLOB_MAGIC.len();
        let ciphertext_start = nonce_start + IV_LENGTH;
        let nonce = Nonce::from_slice(&blob[nonce_start..ciphertext_start]);
        let aad = user_id.to_be_bytes();
        return cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &blob[ciphertext_start..],
                    aad: &aad,
                },
            )
            .map(|plaintext| (plaintext, false))
            .map_err(|_| SyncError::Corrupt);
    }
    if blob.len() < IV_LENGTH {
        return Err(SyncError::Corrupt);
    }
    let nonce = Nonce::from_slice(&blob[..IV_LENGTH]);
    cipher
        .decrypt(nonce, &blob[IV_LENGTH..])
        .map(|plaintext| (plaintext, true))
        .map_err(|_| SyncError::Corrupt)
}

pub(super) fn store_payload_for_user<T: Serialize>(
    state: &AppState,
    user_id: i64,
    payload: T,
) -> SyncResult<String> {
    let cipher = state.aes_cipher.as_ref();
    let pool = &state.pool;
    let compressed = compress_payload(&payload)?;
    let blob = encrypt_blob(cipher, user_id, &compressed)?;
    let mut connection = pool.get().map_err(|_| SyncError::Internal)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| SyncError::Internal)?;
    if transfer::active_is_sealed(&transaction, user_id)? {
        return Err(SyncError::Sealed);
    }
    transaction
            .execute(
                "INSERT INTO sync_data (user_id, data_blob, updated_at)
                 VALUES (?, ?, STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now') || '-' || LOWER(HEX(RANDOMBLOB(8))))
                 ON CONFLICT(user_id) DO UPDATE SET
                    data_blob = excluded.data_blob,
                    updated_at = excluded.updated_at",
                params![user_id, blob],
            )
            .map_err(|error| {
                tracing::error!("sync database write failed: {error}{NEGATIVE}");
                SyncError::Internal
            })?;
    transaction
        .execute("DELETE FROM sync_uploads WHERE user_id = ?", [user_id])
        .map_err(|_| SyncError::Internal)?;
    let updated_at = transaction
        .query_row(
            "SELECT updated_at FROM sync_data WHERE user_id = ?",
            params![user_id],
            |row| row.get(0),
        )
        .map_err(|_| SyncError::Internal)?;
    transaction.commit().map_err(|_| SyncError::Internal)?;
    Ok(updated_at)
}

pub(super) fn load_payload_for_user(
    state: &AppState,
    user_id: i64,
) -> SyncResult<(Snapshot, String)> {
    let pool = &state.pool;
    let cipher = state.aes_cipher.as_ref();
    let connection = pool.get().map_err(|_| SyncError::Internal)?;
    let result: Result<(Vec<u8>, String), rusqlite::Error> = connection.query_row(
        "SELECT data_blob, updated_at FROM sync_data WHERE user_id = ?",
        params![user_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    );
    let (blob, updated_at) = match result {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Err(SyncError::Missing),
        Err(_) => return Err(SyncError::Internal),
    };
    if let Some(id) = transfer::manifest_id(&blob) {
        return Ok((
            transfer::load_snapshot(&connection, cipher, user_id, id)?,
            updated_at,
        ));
    }
    if blob.len() < IV_LENGTH || blob.len() > MAX_BLOB_SIZE {
        return Err(SyncError::Corrupt);
    }
    let (compressed, legacy) = decrypt_blob(cipher, user_id, &blob)?;
    if legacy {
        let migrated = encrypt_blob(cipher, user_id, &compressed)?;
        connection
            .execute(
                "UPDATE sync_data SET data_blob = ? WHERE user_id = ? AND data_blob = ?",
                params![migrated, user_id, blob],
            )
            .map_err(|error| {
                tracing::error!("sync encryption migration failed: {error}{NEGATIVE}");
                SyncError::Internal
            })?;
    }
    drop(connection);
    Ok((decompress_payload(&compressed)?, updated_at))
}
