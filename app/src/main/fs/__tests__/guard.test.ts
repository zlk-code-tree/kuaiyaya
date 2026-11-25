import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MSG } from "../../../shared/messages";
import type { ProbeInfo } from "../../../shared/types";
import { checkGuards } from "../guard";

function probe(path: string): ProbeInfo {
  return {
    path,
    name: "source.mp4",
    sizeBytes: 8 * 1024 * 1024,
    durationSec: 10,
    width: 1280,
    height: 720,
    rotation: 0,
    displayWidth: 1280,
    displayHeight: 720,
    videoCodec: "h264",
    hasAudio: false,
    container: "mp4",
  };
}

describe("output directory guards", () => {
  let dir = "";

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = "";
  });

  it("checks the chosen folder and keeps the source-folder message for the default", async () => {
    dir = await mkdtemp(join(tmpdir(), "kuaiyaya-guard-"));
    const source = join(dir, "source.mp4");
    await writeFile(source, "video");
    const custom = join(dir, "out");
    await writeFile(custom, "not-a-folder");
    const missing = join(dir, "missing");

    expect((await checkGuards(probe(source), null)).ok).toBe(true);
    const blockedFile = await checkGuards(probe(source), null, custom);
    expect(blockedFile.ok).toBe(false);
    expect(blockedFile.message).toBe(MSG.noWriteCustom);
    const blockedMissing = await checkGuards(probe(source), null, missing);
    expect(blockedMissing.message).toBe(MSG.noWriteCustom);
    const blockedSource = await checkGuards(probe(join(dir, "gone", "source.mp4")), null);
    expect(blockedSource.message).toBe(MSG.noWrite);
  });
});
