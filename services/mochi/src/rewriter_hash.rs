use sha2::{Digest, Sha256};
use std::io;
use std::path::Path;

const CRATES: [&str; 3] = ["js", "transform", "coverage-macro"];

fn rust_sources(root: &Path, relative: &str, found: &mut Vec<String>) -> io::Result<()> {
    let entries = match std::fs::read_dir(root.join(relative)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let path = format!("{relative}/{name}");
        let kind = entry.file_type()?;
        if kind.is_dir() {
            rust_sources(root, &path, found)?;
        } else if kind.is_file() && name.ends_with(".rs") {
            found.push(path);
        }
    }
    Ok(())
}

pub fn folio_rewriter_hash(dir: &Path) -> io::Result<String> {
    let mut paths = vec!["Cargo.lock".to_string()];
    for name in CRATES {
        paths.push(format!("{name}/Cargo.toml"));
        rust_sources(dir, &format!("{name}/src"), &mut paths)?;
    }
    paths.sort_unstable();
    let mut identity = Sha256::new();
    for path in paths {
        let digest = hex::encode(Sha256::digest(std::fs::read(dir.join(&path))?));
        identity.update(format!("{path}\n{digest}\n"));
    }
    let mut hash = hex::encode(identity.finalize());
    hash.truncate(16);
    Ok(hash)
}

