import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { KuaiyayaAPI, LicenseState, ProgressEvent, DoneEvent, FailEvent } from "../shared/types";

function on<T>(channel: string, cb: (e: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: KuaiyayaAPI = {
  selectVideo: () => ipcRenderer.invoke("select-video"),
  probe: (filePath) => ipcRenderer.invoke("probe", filePath),
  checkStartGuards: (input) => ipcRenderer.invoke("check-start-guards", input),
  startCompress: (input) => ipcRenderer.invoke("start-compress", input),
  cancelCompress: () => ipcRenderer.invoke("cancel-compress"),
  onCompressProgress: (cb) => on<ProgressEvent>("compress-progress", cb),
  onCompressDone: (cb) => on<DoneEvent>("compress-done", cb),
  onCompressFail: (cb) => on<FailEvent>("compress-fail", cb),
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  revealInFinder: (filePath) => ipcRenderer.invoke("reveal-in-finder", filePath),
  license: {
    getState: () => ipcRenderer.invoke("license-get-state"),
    activate: (key) => ipcRenderer.invoke("license-activate", key),
    reenter: () => ipcRenderer.invoke("license-reenter"),
    onChange: (cb) => on<LicenseState>("license-change", cb),
  },
  about: () => ipcRenderer.invoke("about"),
  copyText: (text) => ipcRenderer.invoke("copy-text", text),
  getEncoderCaps: () => ipcRenderer.invoke("get-encoder-caps"),
  resolveDropPath: (file) => webUtils.getPathForFile(file),
  onOpenFile: (cb) => on<string>("open-dropped-file", cb),
};

contextBridge.exposeInMainWorld("kuaiyaya", api);
