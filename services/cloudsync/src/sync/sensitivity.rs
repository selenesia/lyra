use super::*;

pub(super) fn normalized_parts(name: &str) -> Vec<String> {
    let mut separated = String::with_capacity(name.len());
    let mut previous = None;
    for character in name.chars() {
        if character.is_ascii_uppercase()
            && previous
                .is_some_and(|value: char| value.is_ascii_lowercase() || value.is_ascii_digit())
        {
            separated.push('_');
        }
        if character.is_ascii_alphanumeric() {
            separated.push(character.to_ascii_lowercase());
        } else {
            separated.push('_');
        }
        previous = Some(character);
    }
    separated
        .split('_')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

pub(super) fn sensitive_name(name: &str) -> bool {
    let trimmed = name.trim();
    let normalized = trimmed.to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    let leaf = normalized.rsplit('@').next().unwrap_or(&normalized);
    let original_leaf = trimmed.rsplit('@').next().unwrap_or(trimmed);
    if matches!(
        leaf,
        "auth_user" | "auth_token" | "lyra-sync-meta" | "__lyra_folio_session"
    ) {
        return true;
    }
    let compact = leaf.replace(['-', '_'], "");
    if [
        "accesstoken",
        "refreshtoken",
        "identitytoken",
        "idtoken",
        "authtoken",
        "sessiontoken",
        "apitoken",
        "apikey",
        "privatekey",
        "csrftoken",
        "xsrftoken",
        "oauthtoken",
    ]
    .iter()
    .any(|part| compact.contains(part))
    {
        return true;
    }
    normalized_parts(original_leaf).into_iter().any(|part| {
        matches!(
            part.as_str(),
            "password"
                | "passwd"
                | "secret"
                | "credential"
                | "credentials"
                | "auth"
                | "authorization"
                | "bearer"
                | "cookie"
                | "csrf"
                | "oauth"
                | "token"
                | "jwt"
                | "session"
                | "sessionid"
                | "xsrf"
        )
    })
}

pub(super) fn site_storage_name(name: &str) -> bool {
    name.rsplit_once('@')
        .is_some_and(|(scope, key)| !scope.is_empty() && !key.is_empty())
}

pub(super) fn site_database_name(name: &str) -> bool {
    name.rsplit_once('@').is_some_and(|(origin, database)| {
        !database.is_empty()
            && (origin
                .get(..8)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("https://"))
                || origin
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("http://")))
    })
}

pub(super) fn allows_sensitive_database(name: &str) -> bool {
    matches!(name, "__folio_controller" | "rivet_extensions") || site_database_name(name)
}

pub(super) fn looks_like_jwt(value: &str) -> bool {
    let mut parts = value.trim().split('.');
    let (Some(header), Some(payload), Some(signature)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    parts.next().is_none()
        && header.starts_with("eyJ")
        && payload.starts_with("eyJ")
        && [header, payload, signature].iter().all(|part| {
            part.len() >= 8
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        })
}

pub(super) fn looks_like_provider_credential(value: &str) -> bool {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    let authorization = ["bearer ", "basic "].iter().any(|prefix| {
        lower
            .strip_prefix(prefix)
            .is_some_and(|token| token.len() >= 8)
    });
    let private_key = lower.contains("-----begin ") && lower.contains("private key-----");
    let password_hash = trimmed.starts_with("$2") || trimmed.starts_with("$argon2");
    let provider_prefix = [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxa-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "sk_live_",
        "sk_test_",
    ]
    .iter()
    .any(|prefix| trimmed.starts_with(prefix) && trimmed.len() >= prefix.len() + 12);
    let aws_key = trimmed.len() == 20
        && trimmed.starts_with("AKIA")
        && trimmed
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit());
    authorization || private_key || password_hash || provider_prefix || aws_key
}

pub(super) fn contains_credential_text(value: &str) -> bool {
    if looks_like_jwt(value) || looks_like_provider_credential(value) {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains("private key-----") {
        return true;
    }
    if [
        "$2a$",
        "$2b$",
        "$2y$",
        "$argon2id$",
        "$argon2i$",
        "$argon2d$",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    if [
        "\"access_token\"",
        "\"accesstoken\"",
        "\"refresh_token\"",
        "\"refreshtoken\"",
        "\"auth_token\"",
        "\"authtoken\"",
        "\"session_token\"",
        "\"sessiontoken\"",
        "\"api_key\"",
        "\"apikey\"",
        "\"private_key\"",
        "\"privatekey\"",
        "\"password\"",
        "\"passwd\"",
        "\"secret\"",
        "\"authorization\"",
        "\"credential\"",
        "\"jwt\"",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
    {
        return true;
    }
    if ["bearer ", "basic "].iter().any(|prefix| {
        lower.match_indices(prefix).any(|(index, _)| {
            lower[index + prefix.len()..]
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, '+' | '/' | '_' | '-' | '=')
                })
                .count()
                >= 8
        })
    }) {
        return true;
    }
    if [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
        "xoxb-",
        "xoxa-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "sk_live_",
        "sk_test_",
        "akia",
    ]
    .iter()
    .any(|prefix| {
        lower.match_indices(prefix).any(|(index, _)| {
            lower[index..]
                .chars()
                .take_while(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
                })
                .count()
                >= prefix.len() + 12
        })
    }) {
        return true;
    }
    value
        .split(|character: char| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-'))
        })
        .any(looks_like_jwt)
}

pub(super) fn safe_encoded_bytes(value: &str) -> bool {
    const CHUNK_SIZE: usize = 64 * 1024;
    const OVERLAP: usize = 512;
    if !value.len().is_multiple_of(4)
        || value
            .find('=')
            .is_some_and(|index| index < value.len().saturating_sub(2))
    {
        return false;
    }
    let mut carry = Vec::new();
    for chunk in value.as_bytes().chunks(CHUNK_SIZE) {
        let Ok(decoded) = STANDARD.decode(chunk) else {
            return false;
        };
        let mut scanned = Vec::with_capacity(carry.len() + decoded.len());
        scanned.extend_from_slice(&carry);
        scanned.extend_from_slice(&decoded);
        if contains_credential_text(String::from_utf8_lossy(&scanned).as_ref()) {
            return false;
        }
        carry = scanned[scanned.len().saturating_sub(OVERLAP)..].to_vec();
    }
    true
}

pub(super) fn contains_sensitive_json(value: &Value) -> bool {
    match value {
        Value::String(value) => sensitive_text(value, false),
        Value::Array(values) => values.iter().any(contains_sensitive_json),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| sensitive_name(key) || contains_sensitive_json(value)),
        _ => false,
    }
}

pub(super) fn sensitive_text(value: &str, inspect_json: bool) -> bool {
    if contains_credential_text(value) {
        return true;
    }
    if !inspect_json || value.len() > 1024 * 1024 {
        return false;
    }
    let trimmed = value.trim();
    if !((trimmed.starts_with('{') && trimmed.ends_with('}'))
        || (trimmed.starts_with('[') && trimmed.ends_with(']')))
    {
        return false;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .is_some_and(|parsed| contains_sensitive_json(&parsed))
}
