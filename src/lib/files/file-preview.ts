/**
 * Preview pipeline — deliberately separate from the transfer pipeline.
 *
 * A preview is only ever an object URL of the original File shown in an <img>.
 * Nothing is decoded, re-encoded or drawn to a canvas, so the File (and the
 * bytes that get transferred) stay untouched. If the browser can't render it
 * (Chrome/Windows can't decode HEIC), the UI shows a neutral "Original file" tile.
 */
export function createPreviewUrl(file: File): string {
  return URL.createObjectURL(file);
}

export function revokePreviewUrl(url: string) {
  URL.revokeObjectURL(url);
}
