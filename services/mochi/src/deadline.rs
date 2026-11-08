use axum::{extract::Request, middleware::Next, response::{IntoResponse, Response}, http::StatusCode};
use futures_util::Stream;
use std::{future::Future, pin::Pin, sync::atomic::{AtomicU64, Ordering}, task::{Context, Poll}, time::Duration};
use tokio::sync::oneshot;

static EXPIRED: AtomicU64 = AtomicU64::new(0);
const BODY_IDLE_LIMIT: Duration = Duration::from_secs(60);

struct TimedBody<S> {
    inner: S,
    idle: Pin<Box<tokio::time::Sleep>>,
    received: Option<oneshot::Sender<()>>,
}

impl<S> Stream for TimedBody<S>
where
    S: Stream<Item = Result<bytes::Bytes, axum::Error>> + Unpin,
{
    type Item = Result<bytes::Bytes, std::io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        match Pin::new(&mut self.inner).poll_next(cx) {
            Poll::Ready(Some(Ok(chunk))) => {
                let deadline = tokio::time::Instant::now() + BODY_IDLE_LIMIT;
                self.idle.as_mut().reset(deadline);
                Poll::Ready(Some(Ok(chunk)))
            }
            Poll::Ready(Some(Err(error))) => {
                self.received.take();
                Poll::Ready(Some(Err(std::io::Error::other(error))))
            }
            Poll::Ready(None) => {
                if let Some(received) = self.received.take() {
                    let _ = received.send(());
                }
                Poll::Ready(None)
            }
            Poll::Pending => {
                if self.idle.as_mut().poll(cx).is_ready() {
                    self.received.take();
                    return Poll::Ready(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        crate::negative_message("request body stalled"),
                    ))));
                }
                Poll::Pending
            }
        }
    }
}

fn time_body(request: Request) -> (Request, Option<oneshot::Receiver<()>>) {
    if http_body::Body::is_end_stream(request.body()) {
        return (request, None);
    }
    let (parts, body) = request.into_parts();
    let (sender, receiver) = oneshot::channel();
    let timed = TimedBody {
        inner: body.into_data_stream(),
        idle: Box::pin(tokio::time::sleep(BODY_IDLE_LIMIT)),
        received: Some(sender),
    };
    (Request::from_parts(parts, axum::body::Body::from_stream(timed)), Some(receiver))
}

pub fn expired() -> u64 { EXPIRED.load(Ordering::Relaxed) }
pub async fn headers(request: Request, next: Next) -> Response {
    let budget = if request.uri().path().starts_with(crate::constants::COVER_PREFIX) {
        Duration::from_secs(15)
    } else {
        Duration::from_secs(25)
    };
    let (request, body_received) = time_body(request);
    let response = next.run(request);
    let deadline = async {
        if let Some(body_received) = body_received {
            let _ = body_received.await;
        }
        tokio::time::sleep(budget).await;
    };
    tokio::select! {
        response = response => response,
        _ = deadline => {
            EXPIRED.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(budget_ms = budget.as_millis() as u64, "upstream response deadline exceeded... /ᐠ - ˕ -マ");
            (StatusCode::GATEWAY_TIMEOUT,
                [("cache-control", "no-store"), ("x-error-class", "network-timeout")],
                crate::negative_message("the source took too long to respond")).into_response()
        }
    }
}

