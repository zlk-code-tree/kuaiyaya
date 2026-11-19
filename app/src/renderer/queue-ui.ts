import { MSG } from "../shared/messages";
import { carriedCapMB, displayedQueueSlots, itemTargetMB, normalizeDeviceLimit, queueConcurrencyLine, queueStartAllowed, queueSummaryLine, queueTargetTextFromReady, readSharedTarget, resolveQueueLead, targetSkipsItem, type QueueItemSnapshot, type QueueSnapshot, type QueueStartItem } from "../shared/queue";
import type { AppScreen, LicenseState, ProbeInfo, ProgressEvent } from "../shared/types";
import { isLikelyVideoPath } from "../shared/video-ext";
import { doneSubtitle } from "./done-sub";
import { $, formatDuration, formatElapsed, formatMB, formatRemainDetail, toast } from "./dom";

interface Draft {
  id: string;
  filePath: string;
  probe: ProbeInfo | null;
  error: string | null;
}

export interface QueueController {
  mount(): void;
  ingest(paths: string[], mode: "add" | "replace"): Promise<void>;
  isRunning(): boolean;
  syncStartButton(): void;
}

interface QueueDeps {
  api: Pick<Window["kuaiyaya"], "probe" | "selectVideo" | "queueStart" | "queueCancelItem" | "queueCancelAll" | "queueRetry" | "getQueueConcurrency" | "onQueueUpdate" | "openFile" | "revealInFinder">;
  getScreen: () => AppScreen;
  setScreen: (id: AppScreen) => void;
  currentProbe: () => ProbeInfo | null;
  /** 准备页上已经填好的上限。空着或非法时为 null。 */
  currentReadyCap: () => number | null;
  openSingle: (info: ProbeInfo, carriedMB?: number | null) => void;
  goIdle: () => void;
  hasLicense: () => boolean;
  license: () => Promise<LicenseState>;
  isSingleBusy: () => boolean;
  showAlert: (title: string, text: string, extra?: { reenter?: boolean }) => void;
  handleStartError: (err: unknown) => void;
  askConfirm: (title: string, text: string, yes: string, action: () => void) => void;
  onActivity: () => void;
}

const STATUS_LABEL: Record<QueueItemSnapshot["status"], string> = {
  waiting: "等待中",
  running: "压缩中",
  success: "成功",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : MSG.unsupported;
  return message.replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function baseName(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return filePath.slice(slash + 1) || filePath;
}

function targetField(): HTMLInputElement {
  return $("queueTarget") as HTMLInputElement;
}

export function createQueueController(deps: QueueDeps): QueueController {
  let drafts: Draft[] = [];
  let started = false;
  let waitingKey = false;
  let arming = false;
  let live: QueueSnapshot | null = null;
  let seq = 0;
  let ingestGen = 0;
  let deviceLimit: number | null = null;
  let frozenLine: string | null = null;
  let loadingConcurrency = false;
  let seenRunning = new Set<string>();

  function nextId(): string {
    seq += 1;
    return `q${seq.toString(36)}`;
  }

  function isRunning(): boolean {
    if (waitingKey || arming) return true;
    if (live?.phase === "running") return true;
    return started && live == null;
  }

  function sharedMB(): number | null {
    const read = readSharedTarget(targetField().value);
    return read.kind === "shared" ? read.mb : null;
  }

  function openSingle(info: ProbeInfo): void {
    const carried = deps.getScreen() === "screen-queue"
      ? carriedCapMB(readSharedTarget(targetField().value))
      : null;
    drafts = [];
    clearTargetField();
    deps.openSingle(info, carried);
  }

  function setQueueTargetText(text: string): void {
    const input = targetField();
    input.value = text;
    input.disabled = false;
  }

  function clearTargetField(): void {
    setQueueTargetText("");
  }

  function currentBase(mode: "add" | "replace"): Draft[] {
    if (mode === "replace") return [];
    if (deps.getScreen() === "screen-queue" && !started) return drafts.slice();
    if (deps.getScreen() === "screen-ready") {
      const info = deps.currentProbe();
      if (!info) return [];
      return [{ id: nextId(), filePath: info.path, probe: info, error: null }];
    }
    return [];
  }

  async function ingest(paths: string[], mode: "add" | "replace"): Promise<void> {
    if (deps.isSingleBusy()) return;
    if (!deps.hasLicense()) {
      deps.setScreen("screen-key");
      return;
    }
    if (started || waitingKey || arming) {
      toast(live?.phase === "done" ? "这批已结束，返回后可以再加入视频。" : "已经开始，不能再加入文件");
      return;
    }
    const gen = ++ingestGen;
    let ignored = 0;
    let duplicated = 0;
    const known = new Set(currentBase(mode).map((item) => item.filePath));
    const fresh: string[] = [];
    for (const filePath of paths) {
      if (!filePath) continue;
      if (!isLikelyVideoPath(filePath)) {
        ignored += 1;
        continue;
      }
      if (known.has(filePath)) {
        duplicated += 1;
        continue;
      }
      known.add(filePath);
      fresh.push(filePath);
    }
    const notes: string[] = [];
    if (ignored > 0) notes.push(`已忽略 ${ignored} 个非视频文件`);
    if (duplicated > 0) notes.push("同一视频已在列表中，未重复加入");
    if (notes.length > 0) toast(notes.join("，"));

    const added: Draft[] = [];
    for (const filePath of fresh) {
      if (gen !== ingestGen || started) return;
      try {
        const info = await deps.api.probe(filePath);
        if (gen !== ingestGen || started) return;
        added.push({ id: nextId(), filePath: info.path, probe: info, error: null });
      } catch (err) {
        if (gen !== ingestGen || started) return;
        added.push({ id: nextId(), filePath, probe: null, error: cleanError(err) });
      }
    }
    if (gen !== ingestGen || started || waitingKey || arming) return;

    const base = currentBase(mode);
    const have = new Set(base.map((item) => item.filePath));
    const next = base.concat(added.filter((item) => !have.has(item.filePath)));
    if (next.length === 0) return;
    if (next.length === 1) {
      const only = next[0];
      if (!only) return;
      if (only.probe) {
        if (deps.getScreen() === "screen-ready" && deps.currentProbe()?.path === only.filePath) return;
        openSingle(only.probe);
        return;
      }
      deps.showAlert("无法打开文件", only.error ?? MSG.queueUnreadable);
      if (deps.getScreen() === "screen-queue") {
        drafts = [];
        clearTargetField();
        deps.goIdle();
      }
      return;
    }
    const entering = deps.getScreen() !== "screen-queue";
    const fromReady = deps.getScreen() === "screen-ready";
    drafts = next;
    live = null;
    if (entering) {
      setQueueTargetText(fromReady ? queueTargetTextFromReady(deps.currentReadyCap()) : "");
    }
    deps.setScreen("screen-queue");
    requestConcurrency();
    render();
  }

  function leave(): void {
    if (isRunning()) return;
    drafts = [];
    live = null;
    started = false;
    waitingKey = false;
    frozenLine = null;
    seenRunning = new Set();
    clearTargetField();
    deps.goIdle();
    deps.onActivity();
  }

  function compressibleCount(): number {
    return drafts.filter((item) => item.probe != null && !draftSkipped(item)).length;
  }

  function renderLead(): void {
    $("queueLead").textContent = resolveQueueLead(deviceLimit, compressibleCount(), frozenLine);
  }

  function requestConcurrency(): void {
    if (deviceLimit != null || loadingConcurrency) return;
    loadingConcurrency = true;
    void deps.api.getQueueConcurrency().then((info) => {
      deviceLimit = normalizeDeviceLimit(info.limit);
      loadingConcurrency = false;
      if (frozenLine == null && deps.getScreen() === "screen-queue") render();
    }).catch(() => {
      loadingConcurrency = false;
    });
  }

  function removeDraft(id: string): void {
    if (started || waitingKey || arming) return;
    drafts = drafts.filter((item) => item.id !== id);
    if (drafts.length === 1 && drafts[0]?.probe) {
      const info = drafts[0].probe;
      openSingle(info);
      return;
    }
    if (drafts.length <= 1) {
      drafts = [];
      clearTargetField();
      if (deps.getScreen() === "screen-queue") deps.goIdle();
      return;
    }
    render();
  }

  function draftSkipped(item: Draft): boolean {
    if (!item.probe) return false;
    const read = readSharedTarget(targetField().value);
    return read.kind === "shared" && targetSkipsItem(read.mb, item.probe.sizeBytes);
  }

  function sizeLabel(): string | null {
    const read = readSharedTarget(targetField().value);
    if (read.kind === "shared") return `上限 ${read.mb} MB`;
    if (read.kind === "quality") return "按清晰度自动压";
    return null;
  }

  function syncStartButton(): void {
    const button = $("queueStart") as HTMLButtonElement;
    const read = readSharedTarget(targetField().value);
    if (waitingKey || arming) {
      button.disabled = true;
      button.classList.add("waiting");
      button.innerHTML = '<span class="spinner"></span>请稍候…';
      return;
    }
    button.classList.remove("waiting");
    button.textContent = "开始压缩";
    button.disabled = started || !queueStartAllowed(read);
  }

  function renderHint(): void {
    const hint = $("queueTargetHint");
    const caption = $("queueTargetCaption");
    const read = readSharedTarget(targetField().value);
    hint.classList.toggle("warn", read.kind === "invalid");
    if (read.kind === "invalid") {
      hint.textContent = "请输入 1 以上的整数 MB，或清空后按清晰度自动压。";
      caption.textContent = "请输入有效上限";
      return;
    }
    if (read.kind === "shared") {
      hint.textContent = "全队都不超过这个上限。能压得更小就保留更小的，不会往大了凑。已经不大于上限的会跳过，不影响其余。";
      caption.textContent = "全队共用这个上限";
      return;
    }
    hint.textContent = "留空时，每支按清晰度优先估算能压到多小，再按这个结果压。";
    caption.textContent = "每支按清晰度自动压";
  }

  function renderSummary(): void {
    const box = $("queueSummary");
    if (started && live?.summary) {
      box.textContent = queueSummaryLine(live.summary);
      box.classList.remove("hidden");
      return;
    }
    box.textContent = "";
    box.classList.add("hidden");
  }

  function syncChrome(): void {
    const running = isRunning();
    const failed = live?.summary?.failed ?? 0;
    $("queueStart").classList.toggle("hidden", started);
    $("queueAdd").classList.toggle("hidden", started || waitingKey || arming);
    $("queueCancelAll").classList.toggle("hidden", live?.phase !== "running");
    $("queueRetryFailed").classList.toggle("hidden", !(started && live?.phase === "done" && failed > 0));
    $("queueBack").classList.toggle("hidden", running);
    targetField().disabled = started || waitingKey || arming;
    syncStartButton();
    renderHint();
    renderSummary();
    renderLead();
    deps.onActivity();
  }

  function subline(parts: Array<string | null>): string {
    return parts.filter((part): part is string => Boolean(part)).join("  ·  ");
  }

  function renderProgress(host: HTMLElement, event: ProgressEvent | null): void {
    const wrap = document.createElement("div");
    wrap.className = "queue-progress";
    const bar = document.createElement("div");
    const percent = event?.percent ?? 0;
    bar.className = percent > 0 ? "bar" : "bar indeterminate";
    const fill = document.createElement("i");
    if (percent > 0) fill.style.width = `${percent}%`;
    bar.append(fill);
    const phase = document.createElement("div");
    phase.className = "queue-phase";
    phase.textContent = event?.message ?? "正在按清晰度优先编码";
    const time = document.createElement("div");
    time.className = "queue-time";
    time.textContent = event
      ? `${event.percent}%  ·  ${formatElapsed(event.elapsedSec)}  ·  ${formatRemainDetail(event.elapsedSec, event.etaSec, event.percent)}`
      : "计算预计时间…";
    wrap.append(bar, phase, time);
    host.append(wrap);
  }

  function addButton(parent: HTMLElement, label: string, onClick: () => void): void {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "linkish";
    button.textContent = label;
    button.addEventListener("click", onClick);
    parent.append(button);
  }

  function renderDraftRow(item: Draft): HTMLElement {
    const skipped = draftSkipped(item);
    const status = item.error ? "failed" : skipped ? "skipped" : "waiting";
    const row = document.createElement("div");
    row.className = "queue-row";
    const top = document.createElement("div");
    top.className = "queue-row-top";
    const meta = document.createElement("div");
    meta.className = "file-meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.probe?.name ?? baseName(item.filePath);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = subline([
      item.probe ? formatMB(item.probe.sizeBytes) : null,
      item.probe ? formatDuration(item.probe.durationSec) : null,
      item.probe ? `${item.probe.displayWidth}×${item.probe.displayHeight}` : null,
      sizeLabel(),
    ]) || "无法读取";
    meta.append(name, sub);
    const badge = document.createElement("span");
    badge.className = `queue-status ${status}`;
    badge.textContent = STATUS_LABEL[status];
    top.append(meta, badge);
    row.append(top);
    if (item.error || skipped) {
      const note = document.createElement("div");
      note.className = item.error ? "queue-note err" : "queue-note warn";
      note.textContent = item.error ?? MSG.queueSkipped;
      row.append(note);
    }
    const actions = document.createElement("div");
    actions.className = "queue-row-actions";
    addButton(actions, "移除", () => removeDraft(item.id));
    row.append(actions);
    return row;
  }

  function renderLiveRow(item: QueueItemSnapshot): HTMLElement {
    const row = document.createElement("div");
    row.className = "queue-row";
    row.dataset.queueId = item.id;
    const top = document.createElement("div");
    top.className = "queue-row-top";
    const meta = document.createElement("div");
    meta.className = "file-meta";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = item.name || baseName(item.filePath);
    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = subline([
      item.sizeBytes > 0 ? formatMB(item.sizeBytes) : null,
      item.durationSec > 0 ? formatDuration(item.durationSec) : null,
      item.displayWidth > 0 && item.displayHeight > 0 ? `${item.displayWidth}×${item.displayHeight}` : null,
      item.targetMB == null ? "按清晰度自动压" : `上限 ${item.targetMB} MB`,
      item.outputBytes != null ? `输出 ${formatMB(item.outputBytes)}` : null,
    ]);
    meta.append(name, sub);
    const badge = document.createElement("span");
    badge.className = `queue-status ${item.status}`;
    badge.textContent = STATUS_LABEL[item.status];
    top.append(meta, badge);
    row.append(top);
    if (item.status === "running") renderProgress(row, item.progress);
    if (item.status === "success") {
      const note = document.createElement("div");
      note.className = "queue-note";
      note.textContent = doneSubtitle({
        qualityReduced: item.qualityReduced,
        usedAnalysis: false,
        encoder: item.encoder ?? "x265",
        analysisEncoder: null,
      });
      row.append(note);
    } else if (item.message && item.status !== "running") {
      const note = document.createElement("div");
      note.className = item.status === "failed" ? "queue-note err" : item.status === "skipped" ? "queue-note warn" : "queue-note";
      note.textContent = item.message;
      row.append(note);
    }
    const actions = document.createElement("div");
    actions.className = "queue-row-actions";
    if (item.status === "waiting") {
      addButton(actions, "取消", () => void deps.api.queueCancelItem(item.id));
    } else if (item.status === "running") {
      addButton(actions, "取消", () => {
        deps.askConfirm(MSG.closeWhileWorkTitle, MSG.queueCancelOneDetail, "确定取消", () => {
          void deps.api.queueCancelItem(item.id);
        });
      });
    } else if (item.status === "failed" || item.status === "cancelled") {
      addButton(actions, "重试", () => void deps.api.queueRetry({ id: item.id }));
    } else if (item.status === "success" && item.outputPath) {
      const output = item.outputPath;
      addButton(actions, "打开文件", () => {
        void deps.api.openFile(output).catch((err: unknown) => deps.showAlert("无法打开", cleanError(err)));
      });
      addButton(actions, "打开所在文件夹", () => {
        void deps.api.revealInFinder(output).catch((err: unknown) => deps.showAlert("无法打开", cleanError(err)));
      });
    }
    if (actions.childElementCount > 0) row.append(actions);
    return row;
  }

  function revealNewestRunning(list: HTMLElement, runningIds: string[]): void {
    const fresh = runningIds.filter((id) => !seenRunning.has(id));
    seenRunning = new Set(runningIds);
    const newest = fresh.at(-1);
    if (!newest) return;
    const rows = list.querySelectorAll<HTMLElement>("[data-queue-id]");
    for (const row of rows) {
      if (row.dataset.queueId !== newest) continue;
      row.scrollIntoView({ block: "nearest" });
      return;
    }
  }

  function render(): void {
    const list = $("queueList");
    const scrollTop = list.scrollTop;
    list.replaceChildren();
    if (started && live) {
      for (const item of live.items) list.append(renderLiveRow(item));
      const runningIds = live.items.filter((item) => item.status === "running").map((item) => item.id);
      list.scrollTop = scrollTop;
      revealNewestRunning(list, runningIds);
    } else {
      seenRunning = new Set();
      for (const item of drafts) list.append(renderDraftRow(item));
      list.scrollTop = scrollTop;
    }
    syncChrome();
  }

  function payload(): QueueStartItem[] {
    const mb = sharedMB();
    return drafts.map((item) => ({
      id: item.id,
      filePath: item.filePath,
      name: item.probe?.name ?? baseName(item.filePath),
      targetMB: itemTargetMB(item.probe?.sizeBytes ?? 0, mb),
      sizeBytes: item.probe?.sizeBytes ?? 0,
      durationSec: item.probe?.durationSec ?? 0,
      displayWidth: item.probe?.displayWidth ?? 0,
      displayHeight: item.probe?.displayHeight ?? 0,
    }));
  }

  async function onStart(): Promise<void> {
    if (started || waitingKey || arming || deps.isSingleBusy()) return;
    const read = readSharedTarget(targetField().value);
    if (!queueStartAllowed(read)) return;
    const items = payload();
    arming = true;
    syncChrome();
    try {
      const state = await deps.license();
      if (!state.hasStoredKey) {
        deps.showAlert("尚未开通", "输入有效 Key 后才能开始压缩。不需要注册或登录。");
        return;
      }
      waitingKey = !state.verified;
      syncChrome();
      if (deviceLimit == null) {
        const info = await deps.api.getQueueConcurrency();
        deviceLimit = normalizeDeviceLimit(info.limit);
      }
      frozenLine = queueConcurrencyLine(displayedQueueSlots(deviceLimit, compressibleCount()));
      renderLead();
      const result = await deps.api.queueStart({ items });
      if (!result.ok) {
        waitingKey = false;
        frozenLine = null;
        if (!live) started = false;
        syncChrome();
        if (result.code === "cancelled") return;
        deps.handleStartError({
          message: result.message,
          license: result.code ? { code: result.code, message: result.message } : undefined,
        });
        return;
      }
      waitingKey = false;
      started = true;
      render();
    } catch (err) {
      waitingKey = false;
      frozenLine = null;
      if (!live) started = false;
      syncChrome();
      deps.handleStartError(err);
    } finally {
      arming = false;
      if (!started) syncChrome();
    }
  }

  function mount(): void {
    requestConcurrency();
    targetField().addEventListener("input", () => render());
    $("queueStart").addEventListener("click", () => void onStart());
    $("queueAdd").addEventListener("click", () => {
      if (started || waitingKey || arming || deps.isSingleBusy()) return;
      void deps.api.selectVideo().then((paths) => {
        if (paths.length > 0) return ingest(paths, "add");
        return undefined;
      }).catch((err: unknown) => deps.showAlert("无法打开文件", cleanError(err)));
    });
    $("queueBack").addEventListener("click", leave);
    $("queueCancelAll").addEventListener("click", () => {
      deps.askConfirm(MSG.queueCloseTitle, MSG.queueCloseDetail, "确定取消", () => {
        void deps.api.queueCancelAll();
      });
    });
    $("queueRetryFailed").addEventListener("click", () => void deps.api.queueRetry({ allFailed: true }));
    deps.api.onQueueUpdate((snapshot) => {
      if (!started && !waitingKey && !arming) return;
      live = snapshot;
      if (snapshot.phase === "running" || snapshot.phase === "done") {
        started = true;
        waitingKey = false;
      }
      if (deps.getScreen() === "screen-queue") render();
      else deps.onActivity();
    });
  }

  return { mount, ingest, isRunning, syncStartButton };
}
