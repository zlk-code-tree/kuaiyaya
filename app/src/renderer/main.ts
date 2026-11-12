import type { AnalysisProgress, AppScreen, DoneEvent, FailEvent, LicenseState, ProbeInfo, ProgressEvent, QualityAnalysis } from "../shared/types";
import { MSG } from "../shared/messages";
import { suggestedOutputName } from "../shared/filename";
import { fitOutput, outputLabel } from "../shared/scale";
import { $, formatDuration, formatElapsed, formatMB, formatRemainDetail, toast } from "./dom";
import { showScreen } from "./state/machine";
import { applyInput, fromFileSize, tooLarge, type TargetState } from "./state/target-size";

const api = window.kuaiyaya;

let screen: AppScreen = "screen-key";
let license: LicenseState | null = null;
let probe: ProbeInfo | null = null;
let target: TargetState | null = null;
let lastOutput: string | null = null;
let working = false;
let analyzing = false;
let analysisCancelRequested = false;
let qualityAnalysis: QualityAnalysis | null = null;
let workTimer: number | null = null;
let workOrigin = 0;

function setScreen(id: AppScreen): void {
  screen = id;
  showScreen(id);
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
}

function syncStartButton(): void {
  const btn = $("startBtn") as HTMLButtonElement;
  const blocked = target ? tooLarge(target) : false;
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

function renderTarget(): void {
  if (!probe || !target) return;
  const slider = $("sizeSlider") as HTMLInputElement;
  const input = $("sizeInput") as HTMLInputElement;
  slider.min = String(target.min);
  slider.max = String(target.max);
  slider.value = String(target.targetMB);
  input.value = String(target.targetMB);
  const origMB = probe.sizeBytes / (1024 * 1024);
  const pct = Math.round((target.targetMB / origMB) * 100);
  $("targetHint").textContent = `目标 ${target.targetMB} MB，约为原大小的 ${pct}%。将根据目标分配码率；目标越小，画质损失可能越明显。`;
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
  const matched = qualityAnalysis.candidates.some((item) => item.targetMB === target?.targetMB);
  summary.append(document.createTextNode(matched
    ? `已完成本机抽样分析，建议目标 ${qualityAnalysis.recommendedTargetMB} MB。`
    : "目标已变化，如需对应建议请重新分析。"));
  const review = document.createElement("button");
  review.className = "linkish";
  review.type = "button";
  review.textContent = "查看结果";
  review.addEventListener("click", () => {
    if (qualityAnalysis) showAnalysisResult(qualityAnalysis);
  });
  summary.append(review);
}

function showAnalysisResult(result: QualityAnalysis): void {
  $("analysisTitle").textContent = "抽样分析结果";
  $("analysisStatus").textContent = result.meetsHeuristic
    ? `建议先尝试 ${result.recommendedTargetMB} MB：样片达到参考阈值。`
    : `建议先尝试 ${result.recommendedTargetMB} MB；样片仍有画质损失风险，可调大目标再分析。`;
  $("analysisProgress").classList.add("hidden");
  const results = $("analysisResults");
  results.replaceChildren();
  for (const candidate of result.candidates) {
    const row = document.createElement("div");
    row.className = "analysis-result";
    const title = document.createElement("strong");
    title.textContent = `目标 ${candidate.targetMB} MB${candidate.targetMB === result.recommendedTargetMB ? " · 建议" : ""}`;
    const detail = document.createElement("span");
    const score = result.metric === "vmaf" ? candidate.lowestScore.toFixed(1) : candidate.lowestScore.toFixed(4);
    detail.textContent = `最低片段平均 ${result.metric.toUpperCase()}：${score}；按样片估算全片约 ${formatMB(candidate.estimatedMB * 1024 * 1024)}${candidate.lowBitrateBudget ? "；目标可能过小，码率预算不足" : ""}`;
    row.append(title, detail);
    results.append(row);
  }
  results.classList.remove("hidden");
  $("analysisNote").textContent = `抽取 ${result.sampleCount} 段，共约 ${Math.round(result.sampleDurationSec)} 秒；体积为样片外推，偏差可能较大。评分只供参考，不能保证全片画质，请检查小字、字幕及动态画面。输出分辨率按页面所示限制。`;
  $("analysisNote").classList.remove("hidden");
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
  if (!probe || !target || working || analyzing || $("analysisOverlay").classList.contains("show")) return;
  if (tooLarge(target)) {
    showAlert("无法分析", MSG.targetTooLarge);
    return;
  }
  analyzing = true;
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
    const result = await api.analyzeQuality({ filePath: probe.path, targetMB: target.targetMB });
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

async function loadFile(filePath: string): Promise<void> {
  if (working || analyzing) return;
  if (license && !license.hasStoredKey) {
    setScreen("screen-key");
    return;
  }
  try {
    probe = await api.probe(filePath);
    qualityAnalysis = null;
    target = fromFileSize(probe.sizeBytes);
    fillFileCard();
    renderTarget();
    setScreen("screen-ready");
  } catch (err) {
    showAlert("无法打开文件", err instanceof Error ? err.message : MSG.unsupported);
  }
}

async function chooseFile(): Promise<void> {
  if (working || analyzing) return;
  const p = await api.selectVideo();
  if (p) await loadFile(p);
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
  if (!probe || !target || analyzing || $("analysisOverlay").classList.contains("show")) return;
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
  if (!probe) return "正在按目标体积编码为 HEVC";
  return `正在按目标体积编码为 ${outputLabel({ width: probe.displayWidth, height: probe.displayHeight })} HEVC`;
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

function onDone(ev: DoneEvent): void {
  stopWorkTimer();
  working = false;
  lastOutput = ev.outputPath;
  const usedAnalysis = qualityAnalysis && target && qualityAnalysis.filePath === probe?.path
    && qualityAnalysis.candidates.some((candidate) => candidate.targetMB === target?.targetMB);
  $("doneSub").textContent = usedAnalysis && (ev.retried || ev.encoder !== qualityAnalysis?.encoder)
    ? "输出文件已保存。实际编码参数与试压不同，请检查画质。"
    : "输出文件已保存在原片同一目录";
  $("statBefore").textContent = formatMB(ev.inputBytes);
  $("statAfter").textContent = formatMB(ev.outputBytes);
  const pct = ev.inputBytes > 0 ? Math.round((ev.savedBytes / ev.inputBytes) * 100) : 0;
  $("statSave").textContent = `${formatMB(ev.savedBytes)}（${pct}%）`;
  $("statElapsed").textContent = formatDuration(ev.elapsedSec);
  $("donePath").textContent = ev.outputPath;
  setScreen("screen-done");
  refreshRecent();
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

function bind(): void {
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
  $("aboutClose").addEventListener("click", () => $("aboutOverlay").classList.remove("show"));
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
  $("replaceBtn").addEventListener("click", () => void chooseFile());
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
      target = applyInput(target, qualityAnalysis.recommendedTargetMB);
      renderTarget();
    }
    $("analysisOverlay").classList.remove("show");
    ($("analyzeBtn") as HTMLButtonElement).focus();
  });

  const slider = $("sizeSlider") as HTMLInputElement;
  const input = $("sizeInput") as HTMLInputElement;
  slider.addEventListener("input", () => {
    if (!target) return;
    target = applyInput(target, Number(slider.value));
    renderTarget();
  });
  input.addEventListener("change", () => {
    if (!target) return;
    target = applyInput(target, Number(input.value));
    renderTarget();
  });

  $("cancelBtn").addEventListener("click", () => $("confirmOverlay").classList.add("show"));
  $("confirmNo").addEventListener("click", () => $("confirmOverlay").classList.remove("show"));
  $("confirmYes").addEventListener("click", () => {
    $("confirmOverlay").classList.remove("show");
    void api.cancelCompress();
  });

  $("againBtn").addEventListener("click", () => {
    probe = null;
    target = null;
    qualityAnalysis = null;
    setScreen("screen-idle");
  });
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
  $("failHomeBtn").addEventListener("click", () => {
    probe = null;
    target = null;
    qualityAnalysis = null;
    setScreen("screen-idle");
  });
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
    if (working || analyzing) return;
    $("dropzone").classList.add("dragover");
  });
  window.addEventListener("dragleave", () => $("dropzone").classList.remove("dragover"));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("dragover");
    if (working || analyzing) return;
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    try {
      const p = api.resolveDropPath(file);
      if (p) void loadFile(p);
    } catch {
      showAlert("无法打开文件", MSG.unsupported);
    }
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
}

void boot();
