import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ dir: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mocked.dir } }));
import { loadConfig } from "../paths";

beforeEach(async () => {
  mocked.dir = await mkdtemp(join(tmpdir(), "kuaiyaya-config-test-"));
  vi.stubEnv("KUAIYAYA_API_BASE", "https://env.example.com");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(mocked.dir, { recursive: true, force: true });
});

it("retains an existing user's configured server instead of silently replacing it", async () => {
  await writeFile(join(mocked.dir, "config.json"), JSON.stringify({ apiBaseUrl: "http://127.0.0.1:8080" }));
  expect((await loadConfig()).apiBaseUrl).toBe("http://127.0.0.1:8080");
});

it("uses the environment override when no config file exists", async () => {
  expect((await loadConfig()).apiBaseUrl).toBe("https://env.example.com");
});
