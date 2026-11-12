export function Normalize(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}
