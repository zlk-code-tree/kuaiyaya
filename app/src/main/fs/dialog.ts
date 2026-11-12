import { BrowserWindow, dialog } from "electron";

export async function selectVideo(win: BrowserWindow): Promise<string | null> {
  const res = await dialog.showOpenDialog(win, {
    title: "选择视频",
    properties: ["openFile"],
    filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  return res.filePaths[0];
}
