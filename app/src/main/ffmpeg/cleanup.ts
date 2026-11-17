import { rm } from "node:fs/promises";

export async function removeTempFiles(paths: Array<string | undefined | null>): Promise<void> {
  for (const p of paths) {
    if (!p) continue;
    const extras = [
      p,
      `${p}-0.log`,
      `${p}-0.log.mbtree`,
      `${p}-0.log.cutree`,
      `${p}.log`,
      `${p}.log.mbtree`,
      `${p}.log.cutree`,
    ];
    for (const f of extras) {
      try {
        await rm(f, { force: true });
      } catch {
        // ignore
      }
    }
  }
}
