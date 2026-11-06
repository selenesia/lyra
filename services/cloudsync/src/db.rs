use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use std::path::PathBuf;

pub type DbPool = Pool<SqliteConnectionManager>;

fn db_path() -> PathBuf {
    let path = std::env::var("CLOUDSYNC_DB_PATH").unwrap_or_else(|_| ".db".to_string());
    PathBuf::from(path)
}

pub fn init_pool(
    pool_max: u32,
    pool_min_idle: u32,
    cache_size_kb: i64,
    mmap_size: i64,
) -> Result<DbPool, Box<dyn std::error::Error>> {
    let db_file = db_path();
    let manager = SqliteConnectionManager::file(&db_file).with_init(move |conn| {
        conn.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;
             PRAGMA cache_size = -{};
             PRAGMA mmap_size = {};
             PRAGMA temp_store = MEMORY;
             PRAGMA secure_delete = ON;
             PRAGMA wal_autocheckpoint = 2000;",
            cache_size_kb, mmap_size
        ))
    });
    let pool = Pool::builder()
        .max_size(pool_max)
        .min_idle(Some(pool_min_idle))
        .connection_timeout(std::time::Duration::from_secs(10))
        .build(manager)?;
    let conn = pool.get()?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&db_file, std::fs::Permissions::from_mode(0o600))?;
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            token_version INTEGER DEFAULT 1,
            sync_salt BLOB,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )?;

    ensure_column(&conn, "users", "token_version", "INTEGER DEFAULT 1")?;
    ensure_column(&conn, "users", "sync_salt", "BLOB")?;
    ensure_column(&conn, "users", "opaque_record", "BLOB")?;
    ensure_column(&conn, "users", "wrapped_key", "BLOB")?;
    ensure_column(&conn, "users", "failed_logins", "INTEGER DEFAULT 0")?;
    ensure_column(&conn, "users", "locked_until", "INTEGER DEFAULT 0")?;
    ensure_column(&conn, "users", "opaque_credential", "TEXT")?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS sync_data (
            user_id INTEGER PRIMARY KEY,
            data_blob BLOB NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )",
        [],
    )?;

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)",
        [],
    )?;

    let vacuum_mode: i64 = conn.query_row("PRAGMA auto_vacuum", [], |row| row.get(0))?;
    tracing::info!(auto_vacuum = vacuum_mode, "database page reuse policy");
    init_sync_transfers(&conn)?;

    Ok(pool)
}

fn ensure_column(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let exists = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .flatten()
        .any(|name| name == column);
    if !exists {
        conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

pub(crate) fn init_sync_transfers(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_uploads (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parts INTEGER NOT NULL,
            committed INTEGER NOT NULL DEFAULT 0,
            touched INTEGER NOT NULL DEFAULT (unixepoch()),
            sealed INTEGER NOT NULL DEFAULT 0,
            seal TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sync_uploads_user ON sync_uploads(user_id);
        CREATE TABLE IF NOT EXISTS sync_chunks (
            upload_id TEXT NOT NULL REFERENCES sync_uploads(id) ON DELETE CASCADE,
            part INTEGER NOT NULL,
            data_blob BLOB NOT NULL,
            PRIMARY KEY (upload_id, part)
        );
        CREATE TABLE IF NOT EXISTS sync_objects (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            digest TEXT NOT NULL,
            raw_bytes INTEGER NOT NULL CHECK(raw_bytes > 0 AND raw_bytes <= 1048576),
            data_blob BLOB NOT NULL,
            sealed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, digest)
        );
        CREATE TABLE IF NOT EXISTS sync_upload_digests (
            upload_id TEXT NOT NULL REFERENCES sync_uploads(id) ON DELETE CASCADE,
            part INTEGER NOT NULL,
            digest TEXT NOT NULL,
            PRIMARY KEY (upload_id, part)
        );
        CREATE TABLE IF NOT EXISTS sync_chunk_refs (
            upload_id TEXT NOT NULL REFERENCES sync_uploads(id) ON DELETE CASCADE,
            part INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            digest TEXT NOT NULL,
            PRIMARY KEY (upload_id, part),
            FOREIGN KEY (user_id, digest) REFERENCES sync_objects(user_id, digest)
        );
        CREATE INDEX IF NOT EXISTS idx_sync_chunk_refs_object ON sync_chunk_refs(user_id, digest);",
    )?;
    ensure_column(conn, "sync_uploads", "sealed", "INTEGER NOT NULL DEFAULT 0")?;
    ensure_column(conn, "sync_uploads", "seal", "TEXT")?;
    ensure_column(conn, "sync_objects", "sealed", "INTEGER NOT NULL DEFAULT 0")
}

