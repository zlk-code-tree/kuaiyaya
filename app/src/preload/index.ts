import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { QueueRetryRequest, QueueSnapshot, QueueStartRequest } from "../shared/queue";
import type { KuaiyayaAPI, LicenseState, ProgressEvent, DoneEvent, FailEvent, AnalysisProgress } from "../shared/types";

function on<T>(channel: string, cb: (e: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: KuaiyayaAPI = {
  selectVideo: () => ipcRenderer.invoke("select-video"),
  selectOutputDirectory: () => ipcRenderer.invoke("select-output-directory"),
  queueStart: (input: QueueStartRequest) => ipcRenderer.invoke("queue-start", input),
  queueCancelItem: (id: string) => ipcRenderer.invoke("queue-cancel-item", id),
  queueCancelAll: () => ipcRenderer.invoke("queue-cancel-all"),
  queueRetry: (input: QueueRetryRequest) => ipcRenderer.invoke("queue-retry", input),
  getQueueConcurrency: () => ipcRenderer.invoke("get-queue-concurrency"),
  onQueueUpdate: (cb) => on<QueueSnapshot>("queue-update", cb),
  probe: (filePath) => ipcRenderer.invoke("probe", filePath),
  checkStartGuards: (input) => ipcRenderer.invoke("check-start-guards", input),
  startCompress: (input) => ipcRenderer.invoke("start-compress", input),
  cancelCompress: () => ipcRenderer.invoke("cancel-compress"),
  analyzeQuality: (input) => ipcRenderer.invoke("analyze-quality", input),
  cancelAnalysis: () => ipcRenderer.invoke("cancel-analysis"),
  onAnalysisProgress: (cb) => on<AnalysisProgress>("analysis-progress", cb),
  onCompressProgress: (cb) => on<ProgressEvent>("compress-progress", cb),
  onCompressDone: (cb) => on<DoneEvent>("compress-done", cb),
  onCompressFail: (cb) => on<FailEvent>("compress-fail", cb),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  revealInFinder: (filePath) => ipcRenderer.invoke("reveal-in-finder", filePath),
  acquireOutputPreview: (outputPath) => ipcRenderer.invoke("acquire-output-preview", outputPath),
  releaseOutputPreview: () => ipcRenderer.invoke("release-output-preview"),
  license: {
    getState: () => ipcRenderer.invoke("license-get-state"),
    activate: (key) => ipcRenderer.invoke("license-activate", key),
    reenter: () => ipcRenderer.invoke("license-reenter"),
    onChange: (cb) => on<LicenseState>("license-change", cb),
  },
  about: () => ipcRenderer.invoke("about"),
  checkForUpdates: () => ipcRenderer.invoke("check-for-updates"),
  openUpdateDownload: () => ipcRenderer.invoke("open-update-download"),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  getEncoderCaps: () => ipcRenderer.invoke("get-encoder-caps"),
  resolveDropPath: (file) => webUtils.getPathForFile(file),
  onOpenFile: (cb) => on<string>("open-dropped-file", cb),
};

contextBridge.exposeInMainWorld("kuaiyaya", api);
