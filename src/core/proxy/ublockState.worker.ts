import { readUblockState } from "./ublockState.ts";

self.onmessage = async (event: MessageEvent<{ id: number; input: string }>) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, output: await readUblockState(input) });
  } catch {
    self.postMessage({ id, failed: true });
  }
};
