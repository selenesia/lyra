import { dbGet, EXT_FILES_STORE } from "../db";
import { guessMime } from "../crx";
import { decodeRivetPath, RIVET_APP_BASE, RIVET_CHILD_FRAME_MOUNT_KEY, RIVET_PREFIX } from "../urlScheme";
import { negativeMessage } from "../messages";

const MAX_TRACKED_CLIENTS = 256;
const BOOTSTRAP_SUFFIX = "/__bootstrap__";
const ISOLATED_BACKGROUND_SUFFIX = "/__isolated__";
const ISOLATED_BACKGROUND_SCRIPT = "/b/rv/background.js";
const ISOLATION_POLICY = "isolate-and-credentialless";
const clientToExtId = new Map<string, string>();

function rememberClient(clientId: string, extId: string): void {
  clientToExtId.delete(clientId);
  clientToExtId.set(clientId, extId);
  if (clientToExtId.size > MAX_TRACKED_CLIENTS)
    clientToExtId.delete(clientToExtId.keys().next().value!);
}

function extensionIdFromUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (
      url.origin !== self.location.origin ||
      !url.pathname.startsWith(RIVET_PREFIX)
    )
      return null;
    const rest = url.pathname.slice(RIVET_PREFIX.length);
    const slash = rest.indexOf("/");
    return slash === -1 ? null : rest.slice(0, slash) || null;
  } catch {
    return null;
  }
}

function extensionIdForEvent(event: FetchEvent): string | null {
  const known = event.clientId ? clientToExtId.get(event.clientId) : undefined;
  if (known) return known;
  const fromReferrer = extensionIdFromUrl(event.request.referrer);
  if (fromReferrer && event.clientId)
    rememberClient(event.clientId, fromReferrer);
  return fromReferrer;
}

function responseHeaders(contentType: string): HeadersInit {
  return {
    "Content-Type": contentType,
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

function frameDocumentStub(): string {
  return `<!DOCTYPE html><html><head></head><body><script>(()=>{try{const mount=parent[Symbol.for(${JSON.stringify(RIVET_CHILD_FRAME_MOUNT_KEY)})];if(typeof mount==="function"&&mount(window))return}catch{}fetch(location.href).then((response)=>response.text()).then((html)=>{document.open();document.write(html);document.close()})})()</script></body></html>`;
}

function isolatedBackgroundDocument(): string {
  const appBase = JSON.stringify(RIVET_APP_BASE).replace(/</g, "\\u003c");
  return `<!DOCTYPE html><html><head></head><body><script>globalThis.__LYRA_APP_BASE__=${appBase}</script><script src="${ISOLATED_BACKGROUND_SCRIPT}"></script></body></html>`;
}

function isFrameDocumentNavigation(request: Request, path: string): boolean {
  return (
    request.mode === "navigate" &&
    request.destination === "iframe" &&
    guessMime(path) === "text/html"
  );
}

function bootstrapExtensionId(pathname: string, suffix: string): string | null {
  if (!pathname.startsWith(RIVET_PREFIX) || !pathname.endsWith(suffix))
    return null;
  const extId = pathname.slice(RIVET_PREFIX.length, -suffix.length);
  return extId && !extId.includes("/") ? extId : null;
}

export function shouldRoute(event: FetchEvent): boolean {
  try {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin && url.pathname.startsWith(`${RIVET_APP_BASE}!!/`)) return false;
    if (
      url.origin === self.location.origin &&
      url.pathname.startsWith(RIVET_PREFIX)
    )
      return true;
    return extensionIdForEvent(event) !== null;
  } catch {
    return false;
  }
}

export function extensionNetworkUrl(event: FetchEvent): string | null {
  if (!extensionIdForEvent(event)) return null;
  try {
    const url = new URL(event.request.url);
    if (url.origin === self.location.origin || !/^https?:$/.test(url.protocol))
      return null;
    return url.href;
  } catch {
    return null;
  }
}

async function serveExtensionFile(
  extId: string,
  path: string,
): Promise<Response | null> {
  const bytes = await dbGet<ArrayBuffer>(EXT_FILES_STORE, `${extId}/${path}`);
  if (!bytes) return null;
  return new Response(bytes, {
    status: 200,
    headers: responseHeaders(guessMime(path)),
  });
}

export async function route(event: FetchEvent): Promise<Response> {
  const url = new URL(event.request.url);

  if (url.origin !== self.location.origin) {
    return new Response(
      negativeMessage("rivet extension network request was not routed"),
      { status: 502 },
    );
  }

  const isolatedExtId = bootstrapExtensionId(
    url.pathname,
    ISOLATED_BACKGROUND_SUFFIX,
  );
  if (isolatedExtId) {
    const clientId = (event as unknown as { resultingClientId?: string })
      .resultingClientId;
    if (clientId) rememberClient(clientId, isolatedExtId);
    return new Response(isolatedBackgroundDocument(), {
      status: 200,
      headers: {
        ...responseHeaders("text/html"),
        "Document-Isolation-Policy": ISOLATION_POLICY,
      },
    });
  }

  const bootstrapExtId = bootstrapExtensionId(url.pathname, BOOTSTRAP_SUFFIX);
  if (bootstrapExtId) {
    const clientId = (event as unknown as { resultingClientId?: string })
      .resultingClientId;
    if (clientId) rememberClient(clientId, bootstrapExtId);
    return new Response(
      "<!DOCTYPE html><html><head></head><body></body></html>",
      {
        status: 200,
        headers: responseHeaders("text/html"),
      },
    );
  }

  if (url.pathname.startsWith(RIVET_PREFIX)) {
    const decoded = decodeRivetPath(url.pathname);
    if (!decoded)
      return new Response(
        negativeMessage("extension resource address is malformed"),
        { status: 400, headers: responseHeaders("text/plain") },
      );
    if (event.clientId) rememberClient(event.clientId, decoded.extId);

    const response = await serveExtensionFile(decoded.extId, decoded.path);
    if (response && isFrameDocumentNavigation(event.request, decoded.path)) {
      const clientId = (event as unknown as { resultingClientId?: string })
        .resultingClientId;
      if (clientId) rememberClient(clientId, decoded.extId);
      return new Response(frameDocumentStub(), {
        status: 200,
        headers: responseHeaders("text/html"),
      });
    }
    if (response) return response;
    return new Response(negativeMessage("extension file was not found"), {
      status: 404,
      headers: responseHeaders("text/plain"),
    });
  }

  const extId = extensionIdForEvent(event) ?? undefined;
  if (extId && url.origin === self.location.origin) {
    const response = await serveExtensionFile(
      extId,
      url.pathname.replace(/^\//, ""),
    );
    if (response) return response;
  }
  return fetch(event.request);
}
