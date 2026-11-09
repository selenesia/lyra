import { useEffect, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting";
import { presenceId } from "../../core/runtime/presenceId.ts";
import {
  applyGlobalNotice,
  applyGlobalNoticeTally,
  clearGlobalNotice,
} from "../../features/ui/globalNotice.ts";

export default function Footer() {
  const [clients, setClients] = useState<number | null>(null);

  useEffect(() => {
    const id = presenceId();
    const url = appPath("/api/presence") + (id ? `?id=${id}` : "");
    let events: EventSource | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    let paused = false;
    let greeted = false;
    const close = () => {
      if (events) {
        events.onmessage = null;
        events.onerror = null;
        events.removeEventListener("renew", renew);
        events.removeEventListener("notice", notice);
        events.removeEventListener("tally", tally);
        events.close();
      }
      events = undefined;
      clearTimeout(stale);
      clearTimeout(retry);
    };
    const disconnect = () => {
      close();
      setClients(null);
    };
    const renew = () => {
      close();
      connect();
      if (!events) setClients(null);
    };
    const notice = (event: MessageEvent<string>) => {
      greeted = true;
      applyGlobalNotice(event.data);
    };
    const tally = (event: MessageEvent<string>) => applyGlobalNoticeTally(event.data);
    const reconnect = () => {
      disconnect();
      if (paused || !navigator.onLine) return;
      retry = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    };
    const connect = () => {
      if (events || paused || !navigator.onLine) return;
      clearTimeout(retry);
      events = new EventSource(url);
      greeted = false;
      stale = setTimeout(reconnect, 35_000);
      events.addEventListener("renew", renew);
      events.addEventListener("notice", notice);
      events.addEventListener("tally", tally);
      events.onmessage = (event) => {
        const count = Number(event.data);
        if (!Number.isSafeInteger(count) || count < 1) return;
        if (!greeted) {
          greeted = true;
          clearGlobalNotice();
        }
        setClients(count);
        retryDelay = 1_000;
        clearTimeout(stale);
        stale = setTimeout(reconnect, 35_000);
      };
      events.onerror = reconnect;
    };
    const pause = () => { paused = true; disconnect(); };
    const resume = () => { paused = false; connect(); };
    if (document.readyState === "complete") connect();
    else window.addEventListener("load", connect, { once: true });
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", resume);
    window.addEventListener("offline", disconnect);
    window.addEventListener("online", connect);
    return () => {
      pause();
      window.removeEventListener("load", connect);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("offline", disconnect);
      window.removeEventListener("online", connect);
    };
  }, []);

  return (
    <div class="footer">
      <span class="client-count">
        <span class="client-count-value">{clients ?? "~"}</span>{" "}
        {clients === 1 ? "active client" : "active clients"}
      </span>
      <div id="cute">
        <a class="link" href="https://discord.gg/4GeWaGPh6c/" target="_blank">
          discord
        </a>
        <a class="link" href="https://github.com/gayq/lyra/" target="_blank">
          self-host
        </a>
      </div>
    </div>
  );
}
