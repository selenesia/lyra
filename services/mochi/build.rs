#[path = "src/rewriter_hash.rs"]
mod rewriter_hash;

use std::path::Path;

fn main() {
    let rewriter =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vendor/folio/packages/core/rewriter");
    let hash = rewriter_hash::folio_rewriter_hash(&rewriter)
        .expect("folio rewriter sources could not be read... /ᐠ - ˕ -マ");
    println!("cargo:rustc-env=FOLIO_REWRITER_HASH={hash}");
    for path in [
        "Cargo.lock",
        "js/Cargo.toml",
        "js/src",
        "transform/Cargo.toml",
        "transform/src",
        "coverage-macro/Cargo.toml",
        "coverage-macro/src",
    ] {
        println!("cargo:rerun-if-changed={}", rewriter.join(path).display());
    }
    println!("cargo:rerun-if-changed=src/rewriter_hash.rs");
}
