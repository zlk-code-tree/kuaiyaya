import { BrowserWindow, dialog } from "electron";

export async function selectVideo(win: BrowserWindow): Promise<string[]> {
  const res = await dialog.showOpenDialog(win, {
    title: "选择视频",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return [];
  return res.filePaths;
}
