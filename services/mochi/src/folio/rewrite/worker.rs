use super::protocol::{read_part, write_parts, UrlModel, WorkerJob, WorkerReply};
use base64::Engine as _;
use js::cfg::{Config, Flags, UrlRewriter};
use js::{Rewriter, RewriterError};
use oxc_allocator::{Allocator, StringBuilder};
use std::alloc::{GlobalAlloc, Layout};
use std::cell::RefCell;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicIsize, AtomicUsize, Ordering};

pub const WORKER_ARG: &str = "--folio-rewrite-worker";
pub const MAX_JOB_BYTES: usize = 64 * 1024;
pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const BROTLI_QUALITY: u32 = 5;
const BROTLI_WINDOW: u32 = 22;
const MARKER_FILL: u8 = b'_';

static HEAP_CAP: AtomicUsize = AtomicUsize::new(0);
static HEAP_USED: AtomicIsize = AtomicIsize::new(0);

pub struct CappedAllocator<A>(pub A);

fn charge(bytes: usize) {
    let cap = HEAP_CAP.load(Ordering::Relaxed);
    if cap == 0 {
        return;
    }
    let bytes = bytes as isize;
    if HEAP_USED.fetch_add(bytes, Ordering::Relaxed) + bytes > cap as isize {
        std::process::abort();
    }
}

fn release(bytes: usize) {
    if HEAP_CAP.load(Ordering::Relaxed) != 0 {
        HEAP_USED.fetch_sub(bytes as isize, Ordering::Relaxed);
    }
}

unsafe impl<A: GlobalAlloc> GlobalAlloc for CappedAllocator<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        charge(layout.size());
        self.0.alloc(layout)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        charge(layout.size());
        self.0.alloc_zeroed(layout)
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        release(layout.size());
        self.0.dealloc(pointer, layout)
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if size >= layout.size() {
            charge(size - layout.size());
        } else {
            release(layout.size() - size);
        }
        self.0.realloc(pointer, layout, size)
    }
}

pub fn run_if_requested() -> Option<i32> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some(WORKER_ARG) {
        return None;
    }
    let heap_cap = args
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    HEAP_CAP.store(heap_cap.min(isize::MAX as usize), Ordering::Relaxed);
    let served = serve(io::stdin().lock(), io::stdout().lock());
    Some(if served.is_ok() { 0 } else { 1 })
}

pub fn serve(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let mut session = RewriteSession::new();
    while let Some(job) = read_part(&mut input, MAX_JOB_BYTES)? {
        let body = read_part(&mut input, MAX_BODY_BYTES)?
            .ok_or_else(|| io::Error::from(io::ErrorKind::UnexpectedEof))?;
        let job: WorkerJob = serde_json::from_slice(&job)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "job is invalid"))?;
        let (reply, payload) = session.rewrite(&job, &body);
        let reply = serde_json::to_vec(&reply)?;
        write_parts(&mut output, &[&reply, &payload])?;
        output.flush()?;
    }
    Ok(())
}

pub struct RewriteSession {
    rewriter: Rewriter,
    alloc: Allocator,
}

struct ImportUrl {
    marker: String,
    url: String,
    module: bool,
}

struct ExactWidthUrls<'job> {
    model: Option<UrlModel>,
    nonce: &'job str,
    found: RefCell<Vec<ImportUrl>>,
}

impl UrlRewriter for ExactWidthUrls<'_> {
    fn rewrite(
        &self,
        _config: &Config,
        flags: &Flags,
        url: &str,
        builder: &mut StringBuilder,
        module: bool,
    ) -> Result<(), Box<dyn std::error::Error + Sync + Send>> {
        let model = self.model.ok_or("url model is missing")?;
        let resolved = url::Url::parse(&flags.base)?.join(url)?;
        let mut found = self.found.borrow_mut();
        let mut marker = format!("__mochi_url_{}_{}__", self.nonce, found.len());
        let width = sealed_url_width(model, &resolved).ok_or("url cannot be sealed")?;
        if width < marker.len() {
            return Err("url model is too small".into());
        }
        marker.extend(std::iter::repeat_n(
            MARKER_FILL as char,
            width - marker.len(),
        ));
        builder.push_str(&marker);
        found.push(ImportUrl {
            marker,
            url: resolved.into(),
            module,
        });
        Ok(())
    }
}

fn component_length(text: &str) -> usize {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
                1
            } else {
                3
            }
        })
        .sum()
}

fn base64_length(bytes: usize) -> usize {
    (bytes * 4).div_ceil(3)
}

pub fn sealed_url_width(model: UrlModel, resolved: &url::Url) -> Option<usize> {
    if !matches!(resolved.scheme(), "http" | "https") {
        return None;
    }
    let fragment = resolved.fragment().filter(|fragment| !fragment.is_empty());
    let mut target = resolved.clone();
    target.set_fragment(None);
    let route = base64_length(model.sealed as usize + component_length(target.as_str()));
    let fragment = fragment.map_or(0, |fragment| {
        1 + base64_length(40 + component_length(fragment))
    });
    Some(model.fixed as usize + route + fragment)
}

fn js_whitespace_length(bytes: &[u8]) -> usize {
    match bytes {
        [b'\t' | b'\n' | 0x0b | 0x0c | b'\r' | b' ', ..] => 1,
        [0xc2, 0xa0, ..] => 2,
        [0xe1, 0x9a, 0x80, ..]
        | [0xe2, 0x80, 0x80..=0x8a | 0xa8 | 0xa9 | 0xaf, ..]
        | [0xe2, 0x81, 0x9f, ..]
        | [0xe3, 0x80, 0x80, ..]
        | [0xef, 0xbb, 0xbf, ..] => 3,
        _ => 0,
    }
}

fn strict_directive_end(js: &[u8]) -> Option<usize> {
    let mut start = 0;
    loop {
        let length = js_whitespace_length(&js[start..]);
        if length == 0 {
            break;
        }
        start += length;
    }
    let rest = &js[start..];
    let quote = *rest.first().filter(|quote| matches!(quote, b'"' | b'\''))?;
    let rest = rest[1..].strip_prefix(b"use strict")?;
    let rest = rest.strip_prefix(&[quote])?;
    let rest = rest.strip_prefix(b";").unwrap_or(rest);
    Some(js.len() - rest.len())
}

fn with_sourcemap(job: &WorkerJob, js: &[u8], map: &[u8], tag: &str) -> Vec<u8> {
    if !job.flags.sourcemaps {
        return js.to_vec();
    }
    let js = js.strip_prefix(b"\xef\xbb\xbf").unwrap_or(js);
    let call = format!(
        "{}(\"{}\", \"{}\");",
        job.config.pushsourcemapfn,
        base64::engine::general_purpose::STANDARD.encode(map),
        tag
    );
    let directive = strict_directive_end(js);
    let mut output = Vec::with_capacity(js.len() + call.len() + 1);
    match directive {
        Some(end) => {
            output.extend_from_slice(&js[..end]);
            output.push(b'\n');
            output.extend_from_slice(call.as_bytes());
            output.extend_from_slice(&js[end..]);
        }
        None => {
            output.extend_from_slice(call.as_bytes());
            output.push(b'\n');
            output.extend_from_slice(js);
        }
    }
    output
}

fn patch_frame(mut js: Vec<u8>, urls: &[ImportUrl]) -> Option<Vec<u8>> {
    let mut table = Vec::with_capacity(urls.len());
    let mut cursor = 0;
    for import in urls {
        let offset = cursor + memchr::memmem::find(&js[cursor..], import.marker.as_bytes())?;
        let end = offset + import.marker.len();
        if !matches!(js.get(end), Some(b'"' | b'\'')) {
            return None;
        }
        js[offset..end].fill(MARKER_FILL);
        table.push((offset, import.marker.len(), &import.url, import.module));
        cursor = end;
    }
    let table = serde_json::to_vec(&table).ok()?;
    let mut frame = Vec::with_capacity(4 + table.len() + js.len());
    frame.extend_from_slice(&u32::try_from(table.len()).ok()?.to_be_bytes());
    frame.extend_from_slice(&table);
    frame.extend_from_slice(&js);
    Some(frame)
}

fn compress(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut encoder = brotli::CompressorWriter::new(
        Vec::with_capacity(bytes.len() / 4),
        64 * 1024,
        BROTLI_QUALITY,
        BROTLI_WINDOW,
    );
    encoder.write_all(bytes)?;
    encoder.flush()?;
    Ok(encoder.into_inner())
}

fn random_hex(length: usize) -> String {
    let mut value = uuid::Uuid::new_v4().simple().to_string();
    value.truncate(length);
    value
}

impl RewriteSession {
    pub fn new() -> Self {
        Self {
            rewriter: Rewriter::new(),
            alloc: Allocator::default(),
        }
    }

    pub fn rewrite(&mut self, job: &WorkerJob, body: &[u8]) -> (WorkerReply, Vec<u8>) {
        let result = self.rewrite_body(job, body);
        self.alloc.reset();
        match result {
            Ok((patched, length, payload)) => (WorkerReply::Rewritten { patched, length }, payload),
            Err(reason) => {
                self.rewriter = Rewriter::new();
                (
                    WorkerReply::Declined {
                        reason: reason.into(),
                    },
                    Vec::new(),
                )
            }
        }
    }

    fn rewrite_body(
        &self,
        job: &WorkerJob,
        body: &[u8],
    ) -> Result<(bool, u64, Vec<u8>), &'static str> {
        let source = std::str::from_utf8(body).map_err(|_| "not-utf8")?;
        let config = Config {
            prefix: String::new(),
            wrapfn: job.config.wrapfn.clone(),
            wrappropertybase: job.config.wrappropertybase.clone(),
            wrappropertyfn: job.config.wrappropertyfn.clone(),
            cleanrestfn: job.config.cleanrestfn.clone(),
            importfn: job.config.importfn.clone(),
            rewritefn: job.config.rewritefn.clone(),
            wrappostmessagefn: job.config.wrappostmessagefn.clone(),
            metafn: job.config.metafn.clone(),
            pushsourcemapfn: job.config.pushsourcemapfn.clone(),
            trysetfn: job.config.trysetfn.clone(),
            errfn: job.config.errfn.clone(),
            setrealmfn: job.config.setrealmfn.clone(),
            templocid: job.config.templocid.clone(),
            tempunusedid: job.config.tempunusedid.clone(),
        };
        let tag = random_hex(11);
        let flags = Flags {
            base: job.base.clone(),
            sourcetag: tag.clone(),
            is_module: job.module,
            capture_errors: job.flags.capture_errors,
            scramitize: job.flags.scramitize,
            do_sourcemaps: job.flags.sourcemaps,
            disable_computed_wrap: job.flags.disable_computed_wrap,
            destructure_rewrites: job.flags.destructure_rewrites,
        };
        let nonce = random_hex(16);
        let urls = ExactWidthUrls {
            model: job.urls,
            nonce: &nonce,
            found: RefCell::new(Vec::new()),
        };
        let rewritten = self
            .rewriter
            .rewrite(&self.alloc, source, &config, flags, &urls)
            .map_err(|error| match error {
                RewriterError::Url(_) => "url",
                _ => "parse",
            })?;
        let js = with_sourcemap(job, &rewritten.js, &rewritten.sourcemap, &tag);
        drop(rewritten);
        let urls = urls.found.into_inner();
        let (patched, output) = if urls.is_empty() {
            (false, js)
        } else {
            (true, patch_frame(js, &urls).ok_or("url")?)
        };
        compress(&output)
            .map(|payload| (patched, output.len() as u64, payload))
            .map_err(|_| "output")
    }
}


