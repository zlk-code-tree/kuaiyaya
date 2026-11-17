import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

describe("done-page preview shell", () => {
  const html = readFileSync(join(here, "../../renderer/index.html"), "utf8");
  const main = readFileSync(join(here, "../index.ts"), "utf8");

  it("keeps the existing CSP and only adds the media scheme", () => {
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? "";
    expect(csp).toBe("default-src 'self'; img-src 'self' file: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; media-src 'self' kuaiyaya-media:;");
  });

  it("puts a native video on the single-file done page only", () => {
    const done = section(html, "screen-done");
    expect(done).toContain("<video");
    expect(done).toMatch(/<video\b[^>]*\bcontrols\b/);
    expect(done).not.toMatch(/\bautoplay\b/i);
    expect(done).not.toMatch(/controlsList/i);
    expect(done).not.toContain("file://");
    expect(done).toContain("压缩完成");
    expect(done).toContain("再压缩一个");
    expect(done).toContain("打开所在文件夹");
    expect(done).toContain("打开文件");
    expect(done).not.toContain("result-icon ok");
    expect(section(html, "screen-fail")).not.toContain("<video");
    expect(section(html, "screen-work")).not.toContain("<video");
    expect(section(html, "screen-queue")).not.toContain("<video");
  });

  it("keeps the 740×640 sandboxed window and registers the scheme before ready", () => {
    const ready = main.indexOf("app.whenReady");
    const install = main.indexOf("installMediaHandler(preview)", ready);
    const create = main.indexOf("createWindow();", ready);
    expect(main.indexOf("registerMediaScheme()")).toBeGreaterThan(-1);
    expect(main.indexOf("registerMediaScheme()")).toBeLessThan(ready);
    expect(install).toBeGreaterThan(ready);
    expect(create).toBeGreaterThan(install);
    expect(main).toContain("width: 740");
    expect(main).toContain("height: 640");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("sandbox: true");
    expect(main).not.toContain("webSecurity");
    expect(main).not.toContain("sandbox: false");
    expect(main).not.toContain("nodeIntegration: true");
  });
});
