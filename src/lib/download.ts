export function download(data: Uint8Array | string, filename: string, type: string) {
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
