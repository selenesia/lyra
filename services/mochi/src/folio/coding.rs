use axum::http::header::{ACCEPT_ENCODING, CONTENT_ENCODING};
use axum::http::HeaderMap;
use bytes::Bytes;
use futures_util::stream::{BoxStream, Stream, StreamExt, TryStreamExt};
use serde::{Deserialize, Serialize};
use std::io::{self, Read};

pub const MAX_ZSTD_WINDOW_LOG: u32 = 23;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Coding {
    Gzip,
    Deflate,
    Br,
    Zstd,
}

impl Coding {
    pub fn from_header(value: &[u8]) -> Option<Self> {
        match value {
            b"gzip" => Some(Self::Gzip),
            b"deflate" => Some(Self::Deflate),
            b"br" => Some(Self::Br),
            b"zstd" => Some(Self::Zstd),
            _ => None,
        }
    }

    pub fn of(headers: &HeaderMap) -> Option<Self> {
        let mut values = headers.get_all(CONTENT_ENCODING).iter();
        let coding = Self::from_header(values.next()?.as_bytes());
        if values.next().is_some() {
            return None;
        }
        coding
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Gzip => "gzip",
            Self::Deflate => "deflate",
            Self::Br => "br",
            Self::Zstd => "zstd",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Accepted {
    gzip: bool,
    deflate: bool,
    br: bool,
    zstd: bool,
}

impl Accepted {
    pub fn from_headers(headers: &HeaderMap) -> Self {
        let mut accepted = Self::default();
        let codings = headers
            .get_all(ACCEPT_ENCODING)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','));
        for coding in codings {
            let mut parts = coding.split(';').map(str::trim);
            let Some(name) = parts.next() else { continue };
            let refused = parts.any(|parameter| {
                parameter
                    .strip_prefix("q=")
                    .and_then(|weight| weight.parse::<f32>().ok())
                    .is_some_and(|weight| weight <= 0.0)
            });
            if refused {
                continue;
            }
            match Self::coding_name(name) {
                Some(Coding::Gzip) => accepted.gzip = true,
                Some(Coding::Deflate) => accepted.deflate = true,
                Some(Coding::Br) => accepted.br = true,
                Some(Coding::Zstd) => accepted.zstd = true,
                None => {}
            }
        }
        accepted
    }

    fn coding_name(name: &str) -> Option<Coding> {
        [Coding::Gzip, Coding::Deflate, Coding::Br, Coding::Zstd]
            .into_iter()
            .find(|coding| coding.name().eq_ignore_ascii_case(name))
    }

    pub fn allows(self, coding: Coding) -> bool {
        match coding {
            Coding::Gzip => self.gzip,
            Coding::Deflate => self.deflate,
            Coding::Br => self.br,
            Coding::Zstd => self.zstd,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Invalid,
    TooLarge,
}

fn read_limited(reader: impl Read, limit: usize, output: &mut Vec<u8>) -> Result<(), DecodeError> {
    let mut limited = reader.take((limit as u64).saturating_add(1));
    match limited.read_to_end(output) {
        Ok(read) if read <= limit => Ok(()),
        Ok(_) => Err(DecodeError::TooLarge),
        Err(_) if output.len() > limit => Err(DecodeError::TooLarge),
        Err(_) => Err(DecodeError::Invalid),
    }
}

pub fn decode(coding: Coding, encoded: &[u8], limit: usize) -> Result<Vec<u8>, DecodeError> {
    let mut output = Vec::with_capacity(encoded.len().saturating_mul(4).min(limit));
    match coding {
        Coding::Gzip => read_limited(flate2::read::GzDecoder::new(encoded), limit, &mut output),
        Coding::Deflate => {
            read_limited(flate2::read::ZlibDecoder::new(encoded), limit, &mut output)
        }
        Coding::Br => read_limited(
            brotli::Decompressor::new(encoded, 64 * 1024),
            limit,
            &mut output,
        ),
        Coding::Zstd => {
            let mut decoder = zstd::stream::read::Decoder::with_buffer(encoded)
                .map_err(|_| DecodeError::Invalid)?;
            decoder
                .window_log_max(MAX_ZSTD_WINDOW_LOG)
                .map_err(|_| DecodeError::Invalid)?;
            read_limited(decoder, limit, &mut output)
        }
    }?;
    Ok(output)
}

pub fn decode_stream<S, E>(coding: Coding, stream: S) -> BoxStream<'static, io::Result<Bytes>>
where
    S: Stream<Item = Result<Bytes, E>> + Send + 'static,
    E: Into<Box<dyn std::error::Error + Send + Sync>> + 'static,
{
    use async_compression::tokio::bufread::{BrotliDecoder, GzipDecoder, ZlibDecoder, ZstdDecoder};
    use tokio_util::io::{ReaderStream, StreamReader};
    let reader = StreamReader::new(stream.map_err(io::Error::other).boxed());
    match coding {
        Coding::Gzip => ReaderStream::new(GzipDecoder::new(reader)).boxed(),
        Coding::Deflate => ReaderStream::new(ZlibDecoder::new(reader)).boxed(),
        Coding::Br => ReaderStream::new(BrotliDecoder::new(reader)).boxed(),
        Coding::Zstd => ReaderStream::new(ZstdDecoder::with_params(
            reader,
            &[async_compression::zstd::DParameter::window_log_max(
                MAX_ZSTD_WINDOW_LOG,
            )],
        ))
        .boxed(),
    }
}


