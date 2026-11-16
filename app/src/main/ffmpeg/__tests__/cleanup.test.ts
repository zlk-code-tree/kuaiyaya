import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeTempFiles } from "../cleanup";

describe("removeTempFiles", () => {
  it("removes log, mbtree, and cutree sidecars while keeping the finished video and the source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kuaiyaya-clean-"));
    try {
      const source = join(dir, "input.mp4");
      const output = join(dir, "input_720p.mp4");
      const prefix = join(dir, "input_720p.mp4.x265pass");
      const partial = `${output}.partial`;
      const kept = join(dir, "notes.txt");
      await writeFile(source, "original");
      await writeFile(output, "finished");
      await writeFile(kept, "keep");
      const sidecars = [
        partial,
        prefix,
        `${prefix}-0.log`,
        `${prefix}-0.log.mbtree`,
        `${prefix}-0.log.cutree`,
        `${prefix}.log`,
        `${prefix}.log.mbtree`,
        `${prefix}.log.cutree`,
      ];
      for (const file of sidecars) await writeFile(file, "temp");

      await removeTempFiles([partial, prefix, undefined, null]);

      for (const file of sidecars) expect(existsSync(file)).toBe(false);
      expect(await readFile(source, "utf8")).toBe("original");
      expect(await readFile(output, "utf8")).toBe("finished");
      expect(await readFile(kept, "utf8")).toBe("keep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
