/** Blob + object URL download: works everywhere, no base64, no copies. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Sequential downloads with a small gap so browsers don't drop the later ones. */
export async function downloadAll(files: Array<{ name: string; blob: Blob }>, gapMs = 350) {
  for (const f of files) {
    downloadBlob(f.blob, f.name);
    await new Promise((r) => setTimeout(r, gapMs));
  }
}
