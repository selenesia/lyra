import { createStaticGateway } from "./static-gateway.mjs";
import { nuruTicketMinter } from "./nuru-ticket.mjs";

export function productionStaticGateway(metadata, env = process.env) {
  const backend = env.LYRA_STATIC_BACKEND || "";
  if (backend) {
    let backendUrl;
    try { backendUrl = new URL(backend); } catch { throw new Error("invalid static backend configuration... /ᐠ - ˕ -マ"); }
    if (backendUrl.origin !== backend || (backendUrl.protocol !== "https:" &&
        !(backendUrl.protocol === "http:" && ["127.0.0.1", "localhost"].includes(backendUrl.hostname)))) {
      throw new Error("invalid static backend configuration... /ᐠ - ˕ -マ");
    }
  }
  const wispPath = env.LYRA_WISP_PATH || "/w/";
  if (!/^\/(?:w|[a-f0-9]{64})\/$/.test(wispPath)) {
    throw new Error("invalid static wisp configuration... /ᐠ - ˕ -マ");
  }
  const mochi = env.MOCHI_ORIGIN || "http://127.0.0.1:4000";
  const isao = env.ISAO_ORIGIN || "http://127.0.0.1:6001";
  const app = `http://127.0.0.1:${env.PORT || "4444"}`;
  const nuru = env.NURU_ORIGIN || "ws://127.0.0.1:4001";
  const nuruTicket = nuruTicketMinter(env.NURU_TICKET_SECRET);
  return createStaticGateway({
    backend,
    nuruTicket,
    ...(nuruTicket ? { sessions: (Number(env.LYRA_MEMORY_MB) || 512) * 32, starts: 300, idle: 15 * 60_000 } : {}),
    forward(target, init) {
      const upstream = target.startsWith("/api/anime/") || target.startsWith("/api/watch/") ? isao :
        target.startsWith("/api/") ? app : mochi;
      return fetch(new URL(target, upstream), init);
    },
    metadata: (origin) => ({ ...metadata(origin), wispPath }),
    wispUpstream: ({ path } = {}) => path ? new URL(path, mochi.replace(/^http/, "ws")).href : new URL(wispPath, nuru).href,
  });
}
