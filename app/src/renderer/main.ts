import type { AnalysisProgress, AppScreen, DoneEvent, FailEvent, LicenseState, ProbeInfo, ProgressEvent, QualityAnalysis, UpdateCheckResult } from "../shared/types";
import { MSG } from "../shared/messages";
import { suggestedOutputName } from "../shared/filename";
import { MEDIA_SCHEME, isOutputPreviewUrl } from "../shared/preview-url";
import { fitOutput, outputLabel } from "../shared/scale";
import { clearPreviewVideo, donePreviewView, firstFrameNudge, type DonePreviewAvailability } from "./done-preview";
import { doneSubtitle } from "./done-sub";
import { $, formatDuration, formatElapsed, formatMB, formatRemainDetail, toast } from "./dom";
import { createQueueController, type QueueController } from "./queue-ui";
import { showScreen } from "./state/machine";
import { applySlider, applyTyped, fromFileSize, tooLarge, type TargetState } from "./state/target-size";

const HINT_EMPTY = "没填时，按清晰度估算这支视频在保证画质下能压到多小，再按这个结果压。1080p 及以下不缩小，更高分辨率长边不超过 1920。";
const HINT_CAP = "这个数字是上限。尽量压到这个体积，并在限制里把清晰度做到最好；能压得更小就保留更小的，不会往大了凑。必须小于原片。";
const HINT_INVALID = "请输入 1 以上的整数 MB，或清空后按清晰度自动压。";

const api = window.kuaiyaya;

let screen: AppScreen = "screen-key";
let queue!: QueueController;
let license: LicenseState | null = null;
let probe: ProbeInfo | null = null;
let target: TargetState | null = null;
let lastOutput: string | null = null;
let working = false;
let analyzing = false;
let analysisCancelRequested = false;
let qualityAnalysis: QualityAnalysis | null = null;
let availableUpdate: Extract<UpdateCheckResult, { status: "available" }> | null = null;
let dismissedUpdate: string | null = null;
let workTimer: number | null = null;
let workOrigin = 0;
let previewEpoch = 0;
let previewUrl: string | null = null;
let previewAvailability: DonePreviewAvailability | "idle" = "idle";
let previewLoaded = false;
let previewPlayed = false;
let previewErrored = false;

function setScreen(id: AppScreen): void {
  if (screen === "screen-done" && id !== "screen-done") releaseDonePreview();
  screen = id;
  showScreen(id);
  renderUpdateNotice();
}

function renderUpdateNotice(): void {
  const notice = $("updateNotice");
  const queueRunning = queue.isRunning();
  const visible = availableUpdate && availableUpdate.version !== dismissedUpdate && !working && !analyzing && !queueRunning && screen !== "screen-work";
  notice.classList.toggle("hidden", !visible);
  if (visible && availableUpdate) notice.textContent = `发现新版本 ${availableUpdate.version}`;
  $("aboutUpdateDetails").classList.toggle("hidden", !availableUpdate);
}

async function checkUpdates(manual: boolean): Promise<void> {
  const button = $("checkUpdateBtn") as HTMLButtonElement;
  if (manual) {
    button.disabled = true;
    $("aboutUpdateStatus").textContent = "正在检查…";
  }
  let result: UpdateCheckResult;
  try { result = await api.checkForUpdates(); } catch { result = { status: "error" }; }
  if (result.status === "available") {
    availableUpdate = result;
    if (manual) dismissedUpdate = null;
    $("aboutUpdateStatus").textContent = `发现新版本 ${result.version}`;
  } else if (result.status === "up-to-date") {
    availableUpdate = null;
    $("aboutUpdateStatus").textContent = "当前已是最新版本";
  } else if (result.status === "not-published") {
    availableUpdate = null;
    $("aboutUpdateStatus").textContent = "暂无版本发布信息";
  } else if (manual) {
    $("aboutUpdateStatus").textContent = result.status === "unsupported" ? "当前平台暂不支持更新检查" : "检查失败，请稍后重试";
  }
  if (manual) button.disabled = false;
  renderUpdateNotice();
}

function showUpdate(): void {
  if (!availableUpdate) return;
  if (analyzing || working || queue.isRunning() || screen === "screen-work") {
    $("aboutUpdateStatus").textContent = "压缩或分析完成后可查看更新";
    return;
  }
  $("aboutOverlay").classList.remove("show");
  $("updateTitle").textContent = `发现新版本 ${availableUpdate.version}`;
  $("updateNotes").textContent = availableUpdate.notes.trim() || "本次更新暂无详细说明。";
  $("updateOverlay").classList.add("show");
  ($("updateDownload") as HTMLButtonElement).focus();
}

function dismissUpdate(): void {
  if (availableUpdate) dismissedUpdate = availableUpdate.version;
  $("updateOverlay").classList.remove("show");
  renderUpdateNotice();
  ($("aboutBtn") as HTMLButtonElement).focus();
}

function applyLicense(s: LicenseState): void {
  license = s;
  const banner = $("licenseBanner");
  if (s.banner && s.hasStoredKey && screen !== "screen-key") {
    banner.classList.remove("hidden");
    $("licenseBannerText").textContent = s.banner.text;
    $("bannerKeyBtn").classList.toggle("hidden", !s.banner.showReenter);
  } else {
    banner.classList.add("hidden");
  }
  if (!s.hasStoredKey && screen !== "screen-key") {
    setScreen("screen-key");
  }
  syncStartButton();
  queue.syncStartButton();
}

function syncStartButton(): void {
  const btn = $("startBtn") as HTMLButtonElement;
  const blocked = target ? tooLarge(target) || target.invalid : false;
  if (license?.pendingStart || (license?.silentChecking && license.pendingStart)) {
    btn.disabled = true;
    btn.classList.add("waiting");
    btn.innerHTML = '<span class="spinner"></span>请稍候…';
    return;
  }
  btn.classList.remove("waiting");
  btn.textContent = "开始压缩";
  btn.disabled = blocked || analyzing;
}

function setKeyMsg(kind: "ok" | "err" | "", text: string): void {
  const el = $("keyMsg");
  el.className = "key-msg" + (kind ? ` ${kind}` : "");
  el.textContent = text;
}

function renderTarget(opts?: { keepInput?: boolean }): void {
  if (!probe || !target) return;
  const slider = $("sizeSlider") as HTMLInputElement;
  const input = $("sizeInput") as HTMLInputElement;
  slider.min = String(target.min);
  slider.max = String(Math.max(target.min, target.max));
  const thumb = target.targetMB == null ? target.min : Math.min(Math.max(target.min, target.targetMB), Math.max(target.min, target.max));
  slider.value = String(thumb);
  slider.disabled = target.targetMB == null || target.invalid;
  if (!opts?.keepInput) input.value = target.targetMB == null ? "" : String(target.targetMB);
  const hint = $("targetHint");
  hint.classList.toggle("warn", target.invalid);
  if (target.invalid) {
    hint.textContent = HINT_INVALID;
    $("targetCaption").textContent = "请输入有效上限";
  } else if (target.targetMB == null) {
    hint.textContent = HINT_EMPTY;
    $("targetCaption").textContent = "没填则按清晰度自动压";
  } else {
    hint.textContent = HINT_CAP;
    $("targetCaption").textContent = "这个数字是上限";
  }
  renderAnalysisSummary();
  const banner = $("targetBanner");
  const blocked = tooLarge(target);
  banner.classList.toggle("hidden", !blocked);
  const out = fitOutput({ width: probe.displayWidth, height: probe.displayHeight });
  const dim = outputLabel({ width: probe.displayWidth, height: probe.displayHeight });
  const scaled = out.width !== probe.displayWidth || out.height !== probe.displayHeight;
  $("outRule").textContent = scaled
    ? `输出 ${dim} HEVC（H.265）mp4，带 hvc1 和 faststart。视频会按比例缩小，不放大。将保存为「${suggestedOutputName(probe.path, out)}」，与原片同一目录。`
    : `输出保持 ${dim} HEVC（H.265）mp4，带 hvc1 和 faststart，不缩小。将保存为「${suggestedOutputName(probe.path, out)}」，与原片同一目录。`;
  syncStartButton();
}

function renderAnalysisSummary(): void {
  const summary = $("analysisSummary");
  summary.replaceChildren();
  if (!qualityAnalysis || !target) {
    summary.classList.add("hidden");
    return;
  }
  summary.classList.remove("hidden");
  summary.append(document.createTextNode(analysisHeadline(qualityAnalysis)));
  const review = document.createElement("button");
  review.className = "linkish";
  review.type = "button";
  review.textContent = "查看结果";
  review.addEventListener("click", () => {
    if (qualityAnalysis) showAnalysisResult(qualityAnalysis);
  });
  summary.append(review);
}

function roundedEstimate(estimatedMB: number): number {
  if (!Number.isFinite(estimatedMB)) return 1;
  return Math.max(1, Math.round(estimatedMB));
}

function analysisHeadline(result: QualityAnalysis): string {
  const approx = `按清晰度大约能压到 ${formatMB(result.estimatedMB * 1024 * 1024)}`;
  if (!target || target.invalid || target.targetMB == null) return `${approx}。`;
  return roundedEstimate(result.estimatedMB) <= target.targetMB
    ? `${approx}，已经不超过当前上限 ${target.targetMB} MB。`
    : `${approx}，高于当前上限 ${target.targetMB} MB。`;
}

function showAnalysisResult(result: QualityAnalysis): void {
  $("analysisTitle").textContent = "抽样分析结果";
  $("analysisStatus").textContent = analysisHeadline(result);
  $("analysisProgress").classList.add("hidden");
  const results = $("analysisResults");
  results.replaceChildren();
  results.classList.add("hidden");
  const rounded = roundedEstimate(result.estimatedMB);
  $("analysisNote").textContent = `抽取 ${result.sampleCount} 段，共约 ${Math.round(result.sampleDurationSec)} 秒。这是样片外推，可能有偏差，不能保证全片画质。点「用作上限」将把 ${rounded} MB 设为上限，并必须压进这个体积。`;
  $("analysisNote").classList.remove("hidden");
  ($("analysisApply") as HTMLButtonElement).textContent = "用作上限";
  ($("analysisClose") as HTMLButtonElement).textContent = "关闭";
  $("analysisCancel").classList.add("hidden");
  $("analysisClose").classList.remove("hidden");
  $("analysisApply").classList.remove("hidden");
  $("analysisOverlay").classList.add("show");
  ($("analysisApply") as HTMLButtonElement).focus();
}

function onAnalysisProgress(event: AnalysisProgress): void {
  if (!analyzing || analysisCancelRequested) return;
  $("analysisStatus").textContent = event.message;
  const bar = $("analysisProgressBar");
  const percent = event.total > 0 ? Math.min(100, Math.max(0, Math.round(event.completed / event.total * 100))) : 0;
  bar.style.width = `${percent}%`;
  bar.parentElement?.classList.toggle("indeterminate", percent === 0);
}

async function onAnalyze(): Promise<void> {
  if (!probe || !target || working || analyzing || queue.isRunning() || $("analysisOverlay").classList.contains("show")) return;
  analyzing = true;
  renderUpdateNotice();
  analysisCancelRequested = false;
  const cancel = $("analysisCancel") as HTMLButtonElement;
  cancel.disabled = false;
  cancel.textContent = "取消分析";
  $("analysisTitle").textContent = "正在分析画质";
  $("analysisStatus").textContent = "正在准备，视频和试压片段仅在本机处理。";
  $("analysisProgress").classList.remove("hidden");
  $("analysisProgressBar").style.width = "0%";
  $("analysisProgressBar").parentElement?.classList.add("indeterminate");
  $("analysisResults").classList.add("hidden");
  $("analysisNote").classList.add("hidden");
  $("analysisCancel").classList.remove("hidden");
  $("analysisClose").classList.add("hidden");
  $("analysisApply").classList.add("hidden");
  $("analysisOverlay").classList.add("show");
  cancel.focus();
  syncStartButton();
  try {
    const result = await api.analyzeQuality({ filePath: probe.path, targetMB: target.invalid ? null : target.targetMB });
    if (analysisCancelRequested) return;
    qualityAnalysis = result;
    renderAnalysisSummary();
    showAnalysisResult(result);
  } catch (err) {
    $("analysisOverlay").classList.remove("show");
    if (!analysisCancelRequested) {
      const message = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': Error: /, "") : "画质分析未能完成。";
      showAlert("画质分析未完成", `${message} 原片没有改动，可以重试或直接压缩。`);
    }
  } finally {
    analyzing = false;
    if (analysisCancelRequested) $("analysisOverlay").classList.remove("show");
    syncStartButton();
    renderUpdateNotice();
  }
}

function fillFileCard(): void {
  if (!probe) return;
  const sub = `${formatMB(probe.sizeBytes)}  ·  ${formatDuration(probe.durationSec)}  ·  ${probe.displayWidth}×${probe.displayHeight}`;
  $("fileName").textContent = probe.name;
  $("fileSub").textContent = sub;
  $("workName").textContent = probe.name;
  $("workSub").textContent = sub;
}

function showReady(info: ProbeInfo, carriedMB: number | null = null): void {
  probe = info;
  qualityAnalysis = null;
  target = fromFileSize(info.sizeBytes, carriedMB);
  fillFileCard();
  renderTarget();
  setScreen("screen-ready");
}

function goIdle(): void {
  probe = null;
  target = null;
  qualityAnalysis = null;
  setScreen("screen-idle");
}

async function chooseFile(mode: "add" | "replace" = "add"): Promise<void> {
  if (working || analyzing || queue.isRunning()) return;
  const paths = await api.selectVideo();
  if (paths.length > 0) await queue.ingest(paths, mode);
}

function showAlert(title: string, text: string, extra?: { reenter?: boolean }): void {
  $("alertTitle").textContent = title;
  $("alertText").textContent = text;
  const actions = $("alertActions");
  actions.innerHTML = "";
  if (extra?.reenter) {
    const later = document.createElement("button");
    later.className = "btn btn-secondary";
    later.textContent = "稍后再说";
    later.addEventListener("click", () => $("alertOverlay").classList.remove("show"));
    const re = document.createElement("button");
    re.className = "btn btn-primary";
    re.textContent = "重新输入 Key";
    re.addEventListener("click", () => {
      $("alertOverlay").classList.remove("show");
      void goReenter();
    });
    actions.append(later, re);
  } else {
    const ok = document.createElement("button");
    ok.className = "btn btn-primary";
    ok.id = "alertOk";
    ok.textContent = "知道了";
    ok.addEventListener("click", () => $("alertOverlay").classList.remove("show"));
    actions.append(ok);
  }
  $("alertOverlay").classList.add("show");
}

async function goReenter(): Promise<void> {
  await api.license.reenter();
  setKeyMsg("", "");
  ($("keyInput") as HTMLInputElement).value = "";
  setScreen("screen-key");
  $("licenseBanner").classList.add("hidden");
}

async function onActivate(): Promise<void> {
  const input = $("keyInput") as HTMLInputElement;
  const btn = $("activateBtn") as HTMLButtonElement;
  const key = input.value;
  if (!key.trim()) {
    setKeyMsg("err", MSG.emptyKey);
    return;
  }
  input.disabled = true;
  btn.disabled = true;
  btn.textContent = "开通";
  setKeyMsg("", "正在校验 Key…");
  startKeyProgress();
  try {
    const result = await api.license.activate(key);
    input.disabled = false;
    btn.disabled = false;
    if (result.ok) {
      stopKeyProgress();
      setKeyMsg("ok", result.message);
      setScreen("screen-idle");
      refreshRecent();
    } else {
      stopKeyProgress();
      setKeyMsg("err", result.message);
    }
  } catch (err) {
    input.disabled = false;
    btn.disabled = false;
    stopKeyProgress();
    setKeyMsg("err", err instanceof Error ? err.message : "校验失败，请稍后重试。");
  }
}

async function onStart(): Promise<void> {
  if (!probe || !target || analyzing || queue.isRunning() || $("analysisOverlay").classList.contains("show")) return;
  if (target.invalid) {
    showAlert("无法开始压缩", HINT_INVALID);
    return;
  }
  if (tooLarge(target)) {
    showAlert("无法开始压缩", MSG.targetTooLarge);
    return;
  }
  const guard = await api.checkStartGuards({ filePath: probe.path, targetMB: target.targetMB });
  if (!guard.ok) {
    showAlert("无法开始压缩", guard.message ?? MSG.targetTooLarge);
    return;
  }

  const state = license ?? (await api.license.getState());
  license = state;
  if (state.verified) {
    await beginCompress();
    return;
  }
  if (state.silentChecking || state.hasStoredKey) {
    const btn = $("startBtn") as HTMLButtonElement;
    btn.disabled = true;
    btn.classList.add("waiting");
    btn.innerHTML = '<span class="spinner"></span>请稍候…';
    showValidateUi();
    setScreen("screen-work");
    working = true;
    try {
      await api.startCompress({ filePath: probe.path, targetMB: target.targetMB });
      showCompressUi();
    } catch (err) {
      working = false;
      setScreen("screen-ready");
      syncStartButton();
      handleStartError(err);
    }
    return;
  }
  showAlert("尚未开通", "输入有效 Key 后才能开始压缩。不需要注册或登录。");
}

function handleStartError(err: unknown): void {
  const e = err as { message?: string; license?: { action?: string; code?: string; message?: string } };
  const code = e.license?.code;
  const message = e.license?.message ?? e.message ?? MSG.networkStart;
  if (code === "network") {
    showAlert("网络不通", message);
    return;
  }
  if (code === "invalid" || code === "expired") {
    showAlert("Key 无效或已过期", message, { reenter: true });
    return;
  }
  if (code === "not_bound" || code === "key_bound_to_other_device" || code === "device_bound_to_other_key") {
    showAlert("无法开始压缩", message, { reenter: true });
    return;
  }
  showAlert("无法开始压缩", message);
}

async function beginCompress(): Promise<void> {
  if (!probe || !target) return;
  resetWorkUi();
  startWorkTimer();
  setScreen("screen-work");
  working = true;
  try {
    await api.startCompress({ filePath: probe.path, targetMB: target.targetMB });
  } catch (err) {
    working = false;
    setScreen("screen-ready");
    handleStartError(err);
  }
}

function stopWorkTimer(): void {
  if (workTimer != null) {
    window.clearInterval(workTimer);
    workTimer = null;
  }
}

function startWorkTimer(): void {
  stopWorkTimer();
  workOrigin = Date.now();
  const tick = (): void => {
    $("etaUsed").textContent = formatElapsed((Date.now() - workOrigin) / 1000);
  };
  tick();
  workTimer = window.setInterval(tick, 250);
}

function startKeyProgress(): void {
  $("keyProgress").classList.remove("hidden");
  $("keyProgress").querySelector(".bar")?.classList.add("indeterminate");
  const origin = Date.now();
  const eta = $("keyProgressEta");
  eta.textContent = formatElapsed(0);
  stopWorkTimer();
  const tick = (): void => {
    eta.textContent = formatElapsed((Date.now() - origin) / 1000);
  };
  tick();
  workTimer = window.setInterval(tick, 250);
}

function stopKeyProgress(): void {
  stopWorkTimer();
  $("keyProgress").classList.add("hidden");
}

function encodePhaseText(): string {
  if (!probe) return "正在按清晰度优先编码为 HEVC";
  return `正在按清晰度优先编码为 ${outputLabel({ width: probe.displayWidth, height: probe.displayHeight })} HEVC`;
}

function resetWorkUi(): void {
  // 默认显示单段进度条（本机默认硬编）。软编收到 pass1/pass2 事件后再切到双进度。
  $("twoPass").classList.add("hidden");
  $("singlePass").classList.remove("hidden");
  $("pass1").className = "pass active";
  $("pass2").className = "pass waiting";
  $("pass1Status").textContent = "0%";
  $("pass2Status").textContent = "等待中";
  ($("pass1Bar") as HTMLElement).style.width = "0%";
  ($("pass2Bar") as HTMLElement).style.width = "0%";
  $("singleStatus").textContent = "0%";
  ($("singleBar") as HTMLElement).style.width = "0%";
  $("singlePass").querySelector(".bar")?.classList.add("indeterminate");
  $("workPhase").textContent = encodePhaseText();
  $("etaUsed").textContent = "已用 0秒";
  $("etaRemain").textContent = "计算预计时间…";
}

function showValidateUi(): void {
  resetWorkUi();
  $("workPhase").textContent = "正在校验 Key…";
  $("singleStatus").textContent = "校验中";
  $("etaRemain").textContent = "正在联网确认，请稍候";
  startWorkTimer();
}

function showCompressUi(): void {
  $("workPhase").textContent = encodePhaseText();
  $("singleStatus").textContent = "0%";
  $("etaRemain").textContent = "计算预计时间…";
  $("singlePass").querySelector(".bar")?.classList.add("indeterminate");
  startWorkTimer();
}

function setBar(id: string, percent: number): void {
  const el = $(id);
  el.style.width = `${percent}%`;
  el.parentElement?.classList.toggle("indeterminate", percent <= 0);
}

function onProgress(ev: ProgressEvent): void {
  stopWorkTimer();
  $("workPhase").textContent = ev.message;
  $("etaUsed").textContent = formatElapsed(ev.elapsedSec);
  $("etaRemain").textContent = formatRemainDetail(ev.elapsedSec, ev.etaSec, ev.percent);
  if (ev.phase === "pass1" || ev.phase === "pass2") {
    $("twoPass").classList.remove("hidden");
    $("singlePass").classList.add("hidden");
    if (ev.phase === "pass1") {
      $("pass1").className = "pass active";
      $("pass2").className = "pass waiting";
      $("pass1Status").textContent = `${ev.percent}%`;
      setBar("pass1Bar", ev.percent);
    } else {
      $("pass1").className = "pass done";
      $("pass1Status").textContent = "已完成";
      setBar("pass1Bar", 100);
      $("pass2").className = "pass active";
      $("pass2Status").textContent = `${ev.percent}%`;
      setBar("pass2Bar", ev.percent);
    }
    return;
  }
  $("twoPass").classList.add("hidden");
  $("singlePass").classList.remove("hidden");
  $("singleStatus").textContent = `${ev.percent}%`;
  setBar("singleBar", ev.percent);
}

function doneVideo(): HTMLVideoElement {
  return $("donePreview") as HTMLVideoElement;
}

function applyDonePreview(): void {
  if (previewAvailability === "idle") return;
  const view = donePreviewView({
    availability: previewAvailability,
    loaded: previewLoaded,
    played: previewPlayed,
    errored: previewErrored,
  });
  const video = doneVideo();
  const status = $("donePreviewStatus");
  video.classList.toggle("is-hidden", !view.showVideo);
  status.classList.toggle("hidden", view.message == null);
  status.classList.toggle("is-overlay", view.phase === "interrupted");
  $("donePreviewMsg").textContent = view.message ?? "";
  $("donePreviewRetry").classList.toggle("hidden", !view.canRetry || !previewUrl);
}

function paintFirstFrame(video: HTMLVideoElement, epoch: number): void {
  const paint = () => {
    if (epoch !== previewEpoch || !video.paused || video.currentTime > 0.05) return;
    const nudge = firstFrameNudge(video.duration);
    if (nudge == null) return;
    const onSeeked = () => {
      if (epoch !== previewEpoch || !video.paused) return;
      if (video.currentTime > 0 && video.currentTime <= nudge + 0.0001) video.currentTime = 0;
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    try {
      video.currentTime = nudge;
    } catch {
      video.removeEventListener("seeked", onSeeked);
    }
  };
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) paint();
  else video.addEventListener("loadeddata", paint, { once: true });
}

function releaseDonePreview(): void {
  previewEpoch += 1;
  previewUrl = null;
  previewAvailability = "idle";
  previewLoaded = false;
  previewPlayed = false;
  previewErrored = false;
  const video = doneVideo();
  video.dataset.previewEpoch = "";
  clearPreviewVideo(video);
  video.classList.add("is-hidden");
  $("donePreviewStatus").classList.add("hidden");
  $("donePreviewStatus").classList.remove("is-overlay");
  $("donePreviewRetry").classList.add("hidden");
  void api.releaseOutputPreview().catch(() => undefined);
}

async function showDonePreview(outputPath: string): Promise<void> {
  const epoch = ++previewEpoch;
  previewUrl = null;
  previewAvailability = "checking";
  previewLoaded = false;
  previewPlayed = false;
  previewErrored = false;
  const video = doneVideo();
  video.dataset.previewEpoch = "";
  clearPreviewVideo(video);
  video.dataset.previewEpoch = String(epoch);
  applyDonePreview();
  let issued: string | null = null;
  try {
    issued = await api.acquireOutputPreview(outputPath);
  } catch {
    issued = null;
  }
  if (epoch !== previewEpoch) return;
  if (!issued || !isOutputPreviewUrl(issued)) {
    previewAvailability = issued ? "ready" : "missing";
    previewErrored = Boolean(issued);
    previewUrl = null;
    if (issued) void api.releaseOutputPreview().catch(() => undefined);
    applyDonePreview();
    return;
  }
  previewUrl = issued;
  previewAvailability = "ready";
  video.src = issued;
  paintFirstFrame(video, epoch);
  applyDonePreview();
}

function retryDonePreview(): void {
  if (!previewUrl || !isOutputPreviewUrl(previewUrl) || screen !== "screen-done") return;
  const epoch = ++previewEpoch;
  previewLoaded = false;
  previewPlayed = false;
  previewErrored = false;
  previewAvailability = "ready";
  const video = doneVideo();
  video.dataset.previewEpoch = String(epoch);
  video.pause();
  video.src = previewUrl;
  video.load();
  paintFirstFrame(video, epoch);
  applyDonePreview();
}

function onPreviewMediaEvent(kind: "loaded" | "playing" | "error"): void {
  const video = doneVideo();
  if (video.dataset.previewEpoch !== String(previewEpoch)) return;
  if (previewAvailability !== "ready" || !previewUrl) return;
  if (!video.currentSrc.startsWith(`${MEDIA_SCHEME}:`)) return;
  if (kind === "playing") {
    previewPlayed = true;
    return;
  }
  if (kind === "loaded") {
    if (previewErrored) return;
    previewLoaded = true;
    applyDonePreview();
    return;
  }
  previewErrored = true;
  try { video.pause(); } catch { /* the element is already stopped */ }
  applyDonePreview();
}

function onDone(ev: DoneEvent): void {
  stopWorkTimer();
  working = false;
  lastOutput = ev.outputPath;
  const usedAnalysis = Boolean(qualityAnalysis && qualityAnalysis.filePath === probe?.path);
  $("doneSub").textContent = doneSubtitle({
    qualityReduced: ev.qualityReduced,
    usedAnalysis,
    encoder: ev.encoder,
    analysisEncoder: usedAnalysis ? qualityAnalysis?.encoder ?? null : null,
  });
  $("statBefore").textContent = formatMB(ev.inputBytes);
  $("statAfter").textContent = formatMB(ev.outputBytes);
  const pct = ev.inputBytes > 0 ? Math.round((ev.savedBytes / ev.inputBytes) * 100) : 0;
  $("statSave").textContent = `${formatMB(ev.savedBytes)}（${pct}%）`;
  $("statElapsed").textContent = formatDuration(ev.elapsedSec);
  $("donePath").textContent = ev.outputPath;
  setScreen("screen-done");
  refreshRecent();
  void showDonePreview(ev.outputPath);
}

function onFail(ev: FailEvent): void {
  stopWorkTimer();
  working = false;
  if (ev.cancelled) {
    $("failTitle").textContent = "已取消";
    $("failSub").textContent = ev.message || MSG.cancelled;
  } else {
    $("failTitle").textContent = "压缩失败";
    $("failSub").textContent = ev.message || MSG.encodeFail;
  }
  setScreen("screen-fail");
}

function refreshRecent(): void {
  const box = $("recentBox");
  if (!lastOutput) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  $("recentName").textContent = lastOutput.split("/").pop() ?? lastOutput;
}

async function openAbout(): Promise<void> {
  const info = await api.about();
  $("aboutVersion").textContent = `版本 ${info.version}`;
  ($("copyMailBtn") as HTMLButtonElement).textContent = info.email;
  const img = $("aboutQr") as HTMLImageElement;
  img.src = info.qrSrc;
  $("aboutOverlay").classList.add("show");
}

let confirmAction: () => void = () => undefined;

function askConfirm(title: string, text: string, yes: string, action: () => void): void {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmYes").textContent = yes;
  confirmAction = action;
  $("confirmOverlay").classList.add("show");
}

function bind(): void {
  queue = createQueueController({
    api,
    getScreen: () => screen,
    setScreen,
    currentProbe: () => probe,
    openSingle: (info, carriedMB) => showReady(info, carriedMB ?? null),
    goIdle,
    hasLicense: () => license == null || license.hasStoredKey,
    license: () => license ? Promise.resolve(license) : api.license.getState(),
    isSingleBusy: () => working || analyzing,
    showAlert,
    handleStartError,
    askConfirm,
    onActivity: () => renderUpdateNotice(),
  });
  queue.mount();
  document.addEventListener("keydown", (event) => {
    if (!$('updateOverlay').classList.contains("show")) return;
    if (event.key === "Escape") { event.preventDefault(); dismissUpdate(); return; }
    if (event.key !== "Tab") return;
    const buttons = [$("updateLater"), $("updateDownload")];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) {
      event.preventDefault();
      buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !$("analysisOverlay").classList.contains("show")) return;
    const buttons = ["analysisCancel", "analysisClose", "analysisApply"]
      .map((id) => $(id) as HTMLButtonElement)
      .filter((button) => !button.disabled && !button.classList.contains("hidden"));
    if (!buttons.length) { event.preventDefault(); return; }
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1 || (event.shiftKey && index === 0) || (!event.shiftKey && index === buttons.length - 1)) {
      event.preventDefault();
      buttons[event.shiftKey ? buttons.length - 1 : 0].focus();
    }
  });
  $("aboutBtn").addEventListener("click", () => void openAbout());
  $("checkUpdateBtn").addEventListener("click", () => void checkUpdates(true));
  $("updateNotice").addEventListener("click", showUpdate);
  $("aboutUpdateDetails").addEventListener("click", showUpdate);
  $("updateLater").addEventListener("click", dismissUpdate);
  $("updateDownload").addEventListener("click", () => {
    const button = $("updateDownload") as HTMLButtonElement;
    button.disabled = true;
    void api.openUpdateDownload().then(() => {
      $("updateOverlay").classList.remove("show");
    }).catch(() => {
      $("updateOverlay").classList.remove("show");
      showAlert("无法打开下载页面", "请检查网络后重新检查更新。");
    })
      .finally(() => { button.disabled = false; });
  });
  $("aboutClose").addEventListener("click", () => $("aboutOverlay").classList.remove("show"));
  $("aboutOverlay").addEventListener("click", (event) => {
    if (event.target === event.currentTarget) $("aboutOverlay").classList.remove("show");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("aboutOverlay").classList.remove("show");
  });
  $("copyMailBtn").addEventListener("click", () => {
    void api.copyText("zhanglikunmamba@gmail.com").then(() => toast("已复制邮箱 zhanglikunmamba@gmail.com"));
  });

  $("activateBtn").addEventListener("click", () => void onActivate());
  $("keyInput").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void onActivate();
  });
  $("bannerKeyBtn").addEventListener("click", () => void goReenter());

  $("dropzone").addEventListener("click", () => void chooseFile());
  $("dropzone").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter" || (e as KeyboardEvent).key === " ") {
      e.preventDefault();
      void chooseFile();
    }
  });
  $("replaceBtn").addEventListener("click", () => void chooseFile("replace"));
  $("startBtn").addEventListener("click", () => void onStart());
  $("analyzeBtn").addEventListener("click", () => void onAnalyze());
  $("analysisCancel").addEventListener("click", () => {
    if (!analyzing || analysisCancelRequested) return;
    analysisCancelRequested = true;
    const btn = $("analysisCancel") as HTMLButtonElement;
    btn.disabled = true;
    btn.textContent = "正在取消…";
    $("analysisStatus").textContent = "正在停止试压并清理临时文件…";
    void api.cancelAnalysis().catch(() => undefined);
  });
  $("analysisClose").addEventListener("click", () => {
    $("analysisOverlay").classList.remove("show");
    ($("analyzeBtn") as HTMLButtonElement).focus();
  });
  $("analysisApply").addEventListener("click", () => {
    if (target && qualityAnalysis) {
      target = applyTyped(target, String(roundedEstimate(qualityAnalysis.estimatedMB)));
      renderTarget();
    }
    $("analysisOverlay").classList.remove("show");
    ($("analyzeBtn") as HTMLButtonElement).focus();
  });

  const slider = $("sizeSlider") as HTMLInputElement;
  const input = $("sizeInput") as HTMLInputElement;
  slider.addEventListener("input", () => {
    if (!target || slider.disabled) return;
    target = applySlider(target, Number(slider.value));
    renderTarget();
  });
  input.addEventListener("input", () => {
    if (!target) return;
    target = applyTyped(target, input.value);
    renderTarget({ keepInput: true });
  });
  input.addEventListener("change", () => {
    if (!target) return;
    target = applyTyped(target, input.value);
    renderTarget();
  });

  $("cancelBtn").addEventListener("click", () => {
    askConfirm(MSG.closeWhileWorkTitle, MSG.closeWhileWork, "确定取消", () => {
      void api.cancelCompress();
    });
  });
  $("confirmNo").addEventListener("click", () => $("confirmOverlay").classList.remove("show"));
  $("confirmYes").addEventListener("click", () => {
    $("confirmOverlay").classList.remove("show");
    confirmAction();
  });

  const preview = doneVideo();
  preview.addEventListener("loadeddata", () => onPreviewMediaEvent("loaded"));
  preview.addEventListener("playing", () => onPreviewMediaEvent("playing"));
  preview.addEventListener("error", () => onPreviewMediaEvent("error"));
  $("donePreviewRetry").addEventListener("click", () => retryDonePreview());

  $("againBtn").addEventListener("click", () => goIdle());
  $("openFileBtn").addEventListener("click", () => {
    if (lastOutput) void api.openFile(lastOutput).catch((e: Error) => showAlert("无法打开", e.message));
  });
  $("openFolderBtn").addEventListener("click", () => {
    if (lastOutput) void api.revealInFinder(lastOutput).catch((e: Error) => showAlert("无法打开", e.message));
  });
  $("recentOpenBtn").addEventListener("click", () => {
    if (lastOutput) void api.openFile(lastOutput).catch((e: Error) => showAlert("无法打开", e.message));
  });
  $("recentFolderBtn").addEventListener("click", () => {
    if (lastOutput) void api.revealInFinder(lastOutput).catch((e: Error) => showAlert("无法打开", e.message));
  });
  $("failHomeBtn").addEventListener("click", () => goIdle());
  $("retryBtn").addEventListener("click", () => {
    if (probe && target) {
      setScreen("screen-ready");
      void onStart();
    } else {
      setScreen("screen-idle");
    }
  });

  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (working || analyzing || queue.isRunning()) return;
    if (screen === "screen-idle" || screen === "screen-ready") $("dropzone").classList.add("dragover");
  });
  window.addEventListener("dragleave", () => $("dropzone").classList.remove("dragover"));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("dragover");
    if (working || analyzing) return;
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length === 0) return;
    const paths: string[] = [];
    for (const file of files) {
      try {
        const filePath = api.resolveDropPath(file);
        if (filePath) paths.push(filePath);
      } catch {
        /* 单个文件拿不到路径时忽略，其余继续 */
      }
    }
    if (paths.length === 0) {
      showAlert("无法打开文件", MSG.unsupported);
      return;
    }
    void queue.ingest(paths, "add");
  });

  api.onCompressProgress(onProgress);
  api.onAnalysisProgress(onAnalysisProgress);
  api.onCompressDone(onDone);
  api.onCompressFail(onFail);
  api.license.onChange(applyLicense);
}

async function boot(): Promise<void> {
  bind();
  const state = await api.license.getState();
  applyLicense(state);
  if (state.hasStoredKey) {
    setScreen("screen-idle");
    refreshRecent();
  } else {
    setScreen("screen-key");
  }
  window.setTimeout(() => void checkUpdates(false), 5000);
  window.setInterval(() => void checkUpdates(false), 12 * 60 * 60 * 1000);
}

void boot();
