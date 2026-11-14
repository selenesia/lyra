use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteFlags {
    pub sourcemaps: bool,
    pub capture_errors: bool,
    pub scramitize: bool,
    pub disable_computed_wrap: bool,
    pub destructure_rewrites: bool,
}

impl RewriteFlags {
    pub fn values(&self) -> [bool; 5] {
        [
            self.sourcemaps,
            self.capture_errors,
            self.scramitize,
            self.disable_computed_wrap,
            self.destructure_rewrites,
        ]
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RewriteConfig {
    pub wrapfn: String,
    pub wrappropertybase: String,
    pub wrappropertyfn: String,
    pub cleanrestfn: String,
    pub importfn: String,
    pub rewritefn: String,
    pub wrappostmessagefn: String,
    pub metafn: String,
    pub pushsourcemapfn: String,
    pub trysetfn: String,
    pub errfn: String,
    pub setrealmfn: String,
    pub templocid: String,
    pub tempunusedid: String,
}

impl RewriteConfig {
    pub fn values(&self) -> [&str; 14] {
        [
            &self.wrapfn,
            &self.wrappropertybase,
            &self.wrappropertyfn,
            &self.cleanrestfn,
            &self.importfn,
            &self.rewritefn,
            &self.wrappostmessagefn,
            &self.metafn,
            &self.pushsourcemapfn,
            &self.trysetfn,
            &self.errfn,
            &self.setrealmfn,
            &self.templocid,
            &self.tempunusedid,
        ]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlModel {
    pub fixed: u32,
    pub sealed: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkerJob {
    pub module: bool,
    pub base: String,
    pub flags: RewriteFlags,
    pub config: RewriteConfig,
    pub urls: Option<UrlModel>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum WorkerReply {
    Rewritten { patched: bool, length: u64 },
    Declined { reason: String },
}

pub fn write_parts(output: &mut impl Write, parts: &[&[u8]]) -> io::Result<()> {
    for part in parts {
        let length = u32::try_from(part.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "part is too large"))?;
        output.write_all(&length.to_be_bytes())?;
        output.write_all(part)?;
    }
    Ok(())
}

pub fn read_part(input: &mut impl Read, max: usize) -> io::Result<Option<Vec<u8>>> {
    let mut length = [0u8; 4];
    let mut filled = 0;
    while filled < length.len() {
        match input.read(&mut length[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(read) => filled += read,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    let length = u32::from_be_bytes(length) as usize;
    if length > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "part exceeds the limit",
        ));
    }
    let mut part = vec![0u8; length];
    input.read_exact(&mut part)?;
    Ok(Some(part))
}


