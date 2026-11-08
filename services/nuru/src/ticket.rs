use std::{
    sync::LazyLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{bail, Result};
use base64::{prelude::BASE64_URL_SAFE_NO_PAD, Engine};
use hyper::{header::SEC_WEBSOCKET_PROTOCOL, HeaderMap};
use moka::sync::Cache;
use sha2::{Digest, Sha256};

pub const TICKET_PREFIX: &str = "auth.";
const KEY_PERIOD_SECS: u64 = 3600;
const MAX_TTL_SECS: u64 = 60;

pub static TICKETS: LazyLock<Option<TicketVerifier>> =
    LazyLock::new(|| TicketVerifier::from_env().ok().flatten());

pub struct TicketVerifier {
    secret: Vec<u8>,
    seen: Cache<String, ()>,
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut block = [0u8; 64];
    if key.len() > block.len() {
        block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let mut outer = Sha256::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

fn is_base64url(value: &str) -> bool {
    value
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn split_protocols(headers: &HeaderMap) -> (Vec<String>, Vec<String>) {
    headers
        .get_all(SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .partition(|value| value.starts_with(TICKET_PREFIX))
}

impl TicketVerifier {
    pub fn from_env() -> Result<Option<Self>> {
        match std::env::var("NURU_TICKET_SECRET") {
            Ok(secret) if secret.len() >= 32 => Ok(Some(Self::new(secret.into_bytes()))),
            Ok(secret) if !secret.is_empty() => {
                bail!(negative_message!("ticket secret must be at least 32 bytes"))
            }
            _ => Ok(None),
        }
    }

    fn new(secret: Vec<u8>) -> Self {
        Self {
            secret,
            seen: Cache::builder()
                .max_capacity(262_144)
                .time_to_live(Duration::from_secs(MAX_TTL_SECS + 5))
                .build(),
        }
    }

    pub fn verify(&self, ticket: &str) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        self.verify_at(ticket, now)
    }

    fn verify_at(&self, ticket: &str, now: u64) -> bool {
        let Some(rest) = ticket.strip_prefix(TICKET_PREFIX) else {
            return false;
        };
        let mut parts = rest.split('.');
        let (Some(expires), Some(nonce), Some(signature), None) =
            (parts.next(), parts.next(), parts.next(), parts.next())
        else {
            return false;
        };
        if expires.is_empty() || expires.len() > 12 || !expires.bytes().all(|b| b.is_ascii_digit())
        {
            return false;
        }
        let Ok(expiry) = expires.parse::<u64>() else {
            return false;
        };
        if expiry <= now || expiry > now + MAX_TTL_SECS {
            return false;
        }
        if nonce.len() != 22 || !is_base64url(nonce) || signature.len() != 43 {
            return false;
        }
        let Ok(signature) = BASE64_URL_SAFE_NO_PAD.decode(signature) else {
            return false;
        };
        if signature.len() != 32 {
            return false;
        }
        let message = format!("lyra-nuru/v1\n{expires}\n{nonce}");
        let epoch = now / KEY_PERIOD_SECS;
        let signed = [epoch, epoch.saturating_sub(1)].iter().any(|epoch| {
            let key = hmac_sha256(&self.secret, format!("lyra-nuru/key/{epoch}").as_bytes());
            hmac_sha256(&key, message.as_bytes())
                .iter()
                .zip(&signature)
                .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                == 0
        });
        signed && self.seen.entry(nonce.to_string()).or_insert(()).is_fresh()
    }
}

