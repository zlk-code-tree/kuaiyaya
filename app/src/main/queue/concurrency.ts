import { execFile } from "node:child_process";
import { totalmem } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 16 GiB / 32 GiB。macOS 的 hw.memsize 与 os.totalmem() 都按这个字节数报。 */
const RAM_16 = 16 * 1024 * 1024 * 1024;
const RAM_32 = 32 * 1024 * 1024 * 1024;

/**
 * 已经取好的设备事实。纯函数不要在这里再去读系统。
 * brand 为 null 或空白表示品牌字符串没读到。
 * perfCores 为 null 表示没有 hw.perflevel0.physicalcpu。
 */
export interface QueueDeviceFacts {
  platform: string;
  videotoolbox: boolean;
  brand: string | null;
  totalMemBytes: number;
  perfCores: number | null;
}

export interface ChipFacts {
  brand: string | null;
  totalMemBytes: number;
  perfCores: number | null;
}

/**
 * 按第一次命中的规则给出这一次的并发上限。
 * 1 串行，2 Pro 档，3 Max / Ultra 档。
 */
export function queueConcurrency(facts: QueueDeviceFacts): 1 | 2 | 3 {
  if (!facts.videotoolbox) return 1;
  if (facts.platform !== "darwin") return 1;

  const brand = normalizeBrand(facts.brand);
  if (brand == null) return concurrencyFromCores(facts);
  if (/intel/i.test(brand)) return 1;
  if (!/Apple\s+M\d+/i.test(brand)) return 1;
  if (/\b(?:Ultra|Max)\b/i.test(brand)) return 3;
  if (/\bPro\b/i.test(brand)) return facts.totalMemBytes >= RAM_16 ? 2 : 1;
  if (/Apple\s+M[1-4]\b/i.test(brand)) return 1;
  return concurrencyFromCores(facts);
}

function normalizeBrand(brand: string | null): string | null {
  if (brand == null) return null;
  const text = brand.trim();
  return text.length > 0 ? text : null;
}

function concurrencyFromCores(facts: QueueDeviceFacts): 1 | 2 | 3 {
  const cores = facts.perfCores;
  if (cores == null || !Number.isFinite(cores)) return 1;
  if (facts.totalMemBytes >= RAM_32 && cores >= 8) return 3;
  if (facts.totalMemBytes >= RAM_16 && cores >= 6) return 2;
  return 1;
}

let chipPromise: Promise<ChipFacts> | null = null;

/** 同一进程只探一次芯片和内存。失败则偏保守，不当成高档机器。 */
export function readChipFacts(): Promise<ChipFacts> {
  if (!chipPromise) {
    chipPromise = collectChipFacts().catch(() => ({
      brand: null,
      totalMemBytes: safeTotalMem(),
      perfCores: null,
    }));
  }
  return chipPromise;
}

function safeTotalMem(): number {
  try {
    const bytes = totalmem();
    return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  } catch {
    return 0;
  }
}

async function collectChipFacts(): Promise<ChipFacts> {
  const totalMemBytes = safeTotalMem();
  if (process.platform !== "darwin") {
    return { brand: null, totalMemBytes, perfCores: null };
  }
  const [brand, perfRaw] = await Promise.all([
    sysctl("machdep.cpu.brand_string"),
    sysctl("hw.perflevel0.physicalcpu"),
  ]);
  return { brand, totalMemBytes, perfCores: parseCores(perfRaw) };
}

async function sysctl(key: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("sysctl", ["-n", key], {
      timeout: 3_000,
      encoding: "utf8",
    });
    const text = stdout.trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function parseCores(raw: string | null): number | null {
  if (raw == null) return null;
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}
