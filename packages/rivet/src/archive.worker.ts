import JSZip from "jszip";
import { crxToZip } from "./crx";
import type { ArchiveReply } from "./archive";

let zip: JSZip;
let root = "";

function findManifestRoot(archive: JSZip): string | null {
  let best: string | null = null;
  archive.forEach((path, file) => {
    if (file.dir || path.startsWith("__MACOSX/")) return;
    if (path !== "manifest.json" && !path.endsWith("/manifest.json")) return;
    const prefix = path.slice(0, -"manifest.json".length);
    if (best === null || prefix.split("/").length < best.split("/").length) {
      best = prefix;
    }
  });
  return best;
}

self.onmessage = async ({ data }: MessageEvent<ArrayBuffer | string[]>) => {
  try {
    if (data instanceof ArrayBuffer) {
      zip = await JSZip.loadAsync(crxToZip(data));
      const manifestRoot = findManifestRoot(zip);
      if (manifestRoot === null) {
        self.postMessage({ type: "error" } satisfies ArchiveReply);
        return;
      }
      root = manifestRoot;
      const manifest = JSON.parse(
        await zip.file(`${root}manifest.json`)!.async("text"),
      );
      if (!manifest || typeof manifest.name !== "string") {
        self.postMessage({ type: "error" } satisfies ArchiveReply);
        return;
      }
      const fileList: string[] = [];
      zip.forEach((path, file) => {
        if (!file.dir && path.startsWith(root) && !path.startsWith("__MACOSX/")) {
          fileList.push(path.slice(root.length));
        }
      });
      self.postMessage({
        type: "manifest", manifest, fileList,
      } satisfies ArchiveReply);
    } else {
      const files = await Promise.all(
        data.map((path) => zip.file(root + path)!.async("arraybuffer")),
      );
      self.postMessage({ type: "files", files } satisfies ArchiveReply, {
        transfer: files,
      });
    }
  } catch {
    self.postMessage({ type: "error" } satisfies ArchiveReply);
  }
};
