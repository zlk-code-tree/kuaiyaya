import { describe, expect, it } from "vitest";
import { CLOUD_API, defaultApiBaseUrl, LOCAL_API } from "../api-config";

describe("API defaults", () => {
  it("uses the cloud service on Windows and macOS", () => {
    expect(defaultApiBaseUrl("win32")).toBe("http://8.140.245.64/kuaiyaya");
    expect(defaultApiBaseUrl("darwin")).toBe(CLOUD_API);
    expect(defaultApiBaseUrl("linux")).toBe(LOCAL_API);
  });

  it("allows an explicit environment override on either platform", () => {
    expect(defaultApiBaseUrl("win32", "https://example.com/api")).toBe("https://example.com/api");
    expect(defaultApiBaseUrl("darwin", "https://example.com/api")).toBe("https://example.com/api");
    expect(defaultApiBaseUrl("win32", "")).toBe(CLOUD_API);
    expect(defaultApiBaseUrl("darwin", "")).toBe(CLOUD_API);
  });
});
