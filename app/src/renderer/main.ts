import type { AppScreen, DoneEvent, FailEvent, LicenseState, ProbeInfo, ProgressEvent } from "../shared/types";
import { MSG } from "../shared/messages";
import { suggestedOutputName } from "../shared/filename";
import { $, formatDuration, formatEta, formatMB, toast } from "./dom";
import { showScreen } from "./state/machine";
import { applyInput, fromFileSize, tooLarge, type TargetState } from "./state/target-size";

const api = window.kuaiyaya;

let screen: AppScreen = "screen-key";
let license: LicenseState | null = null;
let probe: ProbeInfo | null = null;
let target: TargetState | null = null;
let lastOutput: string | null = null;
let working = false;

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
  btn.disabled = blocked;
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
  $("targetHint").textContent = `目标 ${target.targetMB} MB，约为原大小的 ${pct}%`;
  const banner = $("targetBanner");
  const blocked = tooLarge(target);
  banner.classList.toggle("hidden", !blocked);
  $("outRule").textContent =
    `输出 1080p HEVC（H.265）mp4，带 hvc1 和 faststart。将保存为「${suggestedOutputName(probe.path)}」，与原片同一目录。`;
  syncStartButton();
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
  if (working) return;
  if (license && !license.hasStoredKey) {
    setScreen("screen-key");
    return;
  }
  try {
    probe = await api.probe(filePath);
    target = fromFileSize(probe.sizeBytes);
    fillFileCard();
    renderTarget();
    setScreen("screen-ready");
  } catch (err) {
    showAlert("无法打开文件", err instanceof Error ? err.message : MSG.unsupported);
  }
}

async function chooseFile(): Promise<void> {
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
  const result = await api.license.activate(key);
  input.disabled = false;
  btn.disabled = false;
  if (result.ok) {
    setKeyMsg("ok", result.message);
    setScreen("screen-idle");
    refreshRecent();
  } else {
    setKeyMsg("err", result.message);
  }
}

async function onStart(): Promise<void> {
  if (!probe || !target) return;
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
    try {
      await api.startCompress({ filePath: probe.path, targetMB: target.targetMB });
      // 主进程在已通过时才会真正开压；未通过会抛出分类错误。
      resetWorkUi();
      setScreen("screen-work");
      working = true;
    } catch (err) {
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

function resetWorkUi(): void {
  $("twoPass").classList.remove("hidden");
  $("singlePass").classList.add("hidden");
  $("pass1").className = "pass active";
  $("pass2").className = "pass waiting";
  $("pass1Status").textContent = "0%";
  $("pass2Status").textContent = "等待中";
  ($("pass1Bar") as HTMLElement).style.width = "0%";
  ($("pass2Bar") as HTMLElement).style.width = "0%";
  $("singleStatus").textContent = "0%";
  ($("singleBar") as HTMLElement).style.width = "0%";
  $("workPhase").textContent = "第一遍：分析画面，为第二遍编码做准备";
  $("eta").textContent = "计算剩余时间…";
}

function onProgress(ev: ProgressEvent): void {
  $("workPhase").textContent = ev.message;
  $("eta").textContent = formatEta(ev.etaSec);
  if (ev.phase === "pass1" || ev.phase === "pass2") {
    $("twoPass").classList.remove("hidden");
    $("singlePass").classList.add("hidden");
    if (ev.phase === "pass1") {
      $("pass1").className = "pass active";
      $("pass2").className = "pass waiting";
      $("pass1Status").textContent = `${ev.percent}%`;
      ($("pass1Bar") as HTMLElement).style.width = `${ev.percent}%`;
    } else {
      $("pass1").className = "pass done";
      $("pass1Status").textContent = "已完成";
      ($("pass1Bar") as HTMLElement).style.width = "100%";
      $("pass2").className = "pass active";
      $("pass2Status").textContent = `${ev.percent}%`;
      ($("pass2Bar") as HTMLElement).style.width = `${ev.percent}%`;
    }
    return;
  }
  $("twoPass").classList.add("hidden");
  $("singlePass").classList.remove("hidden");
  $("singleStatus").textContent = `${ev.percent}%`;
  ($("singleBar") as HTMLElement).style.width = `${ev.percent}%`;
}

function onDone(ev: DoneEvent): void {
  working = false;
  lastOutput = ev.outputPath;
  $("doneSub").textContent = "输出文件已保存在原片同一目录";
  $("statBefore").textContent = formatMB(ev.inputBytes);
  $("statAfter").textContent = formatMB(ev.outputBytes);
  const pct = ev.inputBytes > 0 ? Math.round((ev.savedBytes / ev.inputBytes) * 100) : 0;
  $("statSave").textContent = `${formatMB(ev.savedBytes)}（${pct}%）`;
  $("donePath").textContent = ev.outputPath;
  setScreen("screen-done");
  refreshRecent();
}

function onFail(ev: FailEvent): void {
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
    if (working) return;
    $("dropzone").classList.add("dragover");
  });
  window.addEventListener("dragleave", () => $("dropzone").classList.remove("dragover"));
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    $("dropzone").classList.remove("dragover");
    if (working) return;
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
