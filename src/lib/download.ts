type DownloadsApi = { save(req: { filename: string; data: string | Uint8Array }): Promise<unknown> };
type ClaudeHost = { use(name: string): Promise<unknown> };

/**
 * Save a generated file. Inside a hosted artifact the viewer's frame blocks plain downloads,
 * so use the host's "downloads" capability when it exists; otherwise a normal browser download.
 */
export async function download(data: Uint8Array | string, filename: string, type: string): Promise<void> {
  const host = (globalThis as { claude?: ClaudeHost }).claude;
  if (host?.use) {
    const api = (await host.use("downloads")) as DownloadsApi | null;
    if (api) {
      try {
        await api.save({ filename, data: typeof data === "string" ? data : data.slice() });
      } catch {
        /* viewer declined or saving is unavailable here; nothing else to do */
      }
      return;
    }
  }
  const blob = new Blob([typeof data === "string" ? data : (data as BlobPart)], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readFile(f: File): Promise<Uint8Array> {
  return new Uint8Array(await f.arrayBuffer());
}

/** "Founders agreement.pdf" -> "Founders agreement" */
export function baseName(name: string) {
  return name.replace(/\.pdf$/i, "");
}
