/** Well-known preview address. The renderer must receive this from IPC, not build a file URL. */
export const MEDIA_SCHEME = "kuaiyaya-media";
export const OUTPUT_PREVIEW_URL = `${MEDIA_SCHEME}://preview/output`;

export function isOutputPreviewUrl(value: unknown): value is string {
  return value === OUTPUT_PREVIEW_URL;
}
