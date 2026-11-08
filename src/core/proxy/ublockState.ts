export async function readUblockState(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
  return new Response(
    gzipped
      ? new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))
      : bytes,
  ).json();
}
