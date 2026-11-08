import { setRealmApi } from "../chromeApi/common";
import { readExtFileText } from "../fileStore";
import {
  injectScriptFromUrl,
  installClassicWorkerGlobals,
  preloadClassicWorkerImports,
  rewriteExtHtml,
  writeDocument,
} from "../htmlInject";
import { NEGATIVE } from "../messages";
import { installExtensionNetwork } from "../network";
import { buildExtensionUrl, extensionDocumentUrl } from "../urlScheme";
import { createIsolatedChromeApi } from "./frameApi";
import {
  ISOLATED_BACKGROUND_HELLO,
  ISOLATED_BACKGROUND_INIT,
  type FrameToHostMessage,
  type IsolatedBackgroundInit,
} from "./protocol";

const EMPTY_DOCUMENT = "<!DOCTYPE html><html><head></head><body></body></html>";

function documentLoaded(): Promise<void> {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) =>
    addEventListener("load", () => resolve(), { once: true }),
  );
}

async function runBackground(
  init: IsolatedBackgroundInit,
  port: MessagePort,
): Promise<void> {
  const { background, extId } = init;
  const api = createIsolatedChromeApi(window, port, init);
  const prepare = (realm: Window) => {
    installExtensionNetwork(realm, init.senderUrl, api.responseTimeoutMs);
    setRealmApi(realm, "chrome", api.chrome);
    if (!setRealmApi(realm, "browser", api.browser)) {
      console.warn(
        "[rivet] browser api could not be installed in this frame",
        NEGATIVE,
      );
    }
  };
  const backgroundPath =
    background.type === "page"
      ? background.page
      : background.type === "worker"
        ? background.script
        : background.scripts[0];
  const classicWorkerImports =
    background.type === "worker" && !background.isModule
      ? await preloadClassicWorkerImports(extId, background.script)
      : new Map<string, string>();
  const pageSource =
    background.type === "page"
      ? await readExtFileText(extId, background.page)
      : null;
  await documentLoaded();
  if (backgroundPath)
    history.replaceState(null, "", buildExtensionUrl(extId, backgroundPath));

  if (background.type === "page") {
    const html =
      pageSource !== null
        ? await rewriteExtHtml(extId, pageSource, background.page)
        : EMPTY_DOCUMENT;
    await writeDocument(
      window,
      html,
      prepare,
      extensionDocumentUrl(background.page),
    );
    return;
  }

  await writeDocument(
    window,
    EMPTY_DOCUMENT,
    prepare,
    backgroundPath ? extensionDocumentUrl(backgroundPath) : undefined,
  );
  const scriptPaths =
    background.type === "worker" ? [background.script] : background.scripts;
  const isModule = background.type === "worker" && background.isModule;
  if (background.type === "worker" && !isModule) {
    installClassicWorkerGlobals(
      window,
      extId,
      background.script,
      classicWorkerImports,
    );
  }
  for (const path of scriptPaths)
    await injectScriptFromUrl(window, buildExtensionUrl(extId, path), isModule);
}

function receiveInit(event: MessageEvent): void {
  const init = event.data as IsolatedBackgroundInit | undefined;
  const port = event.ports[0];
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    init?.type !== ISOLATED_BACKGROUND_INIT ||
    !port
  )
    return;
  removeEventListener("message", receiveInit);
  const report = (message: FrameToHostMessage) => port.postMessage(message);
  runBackground(init, port).then(
    () => report({ type: "ready" }),
    (error) => {
      console.error(
        "[rivet] isolated background startup failed",
        error,
        NEGATIVE,
      );
      report({ type: "failed" });
    },
  );
}

addEventListener("message", receiveInit);
parent.postMessage({ type: ISOLATED_BACKGROUND_HELLO }, location.origin);
