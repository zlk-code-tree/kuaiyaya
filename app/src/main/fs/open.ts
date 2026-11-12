import { shell } from "electron";
import { access } from "node:fs/promises";

export async function openFile(filePath: string): Promise<void> {
  await access(filePath);
  const err = await shell.openPath(filePath);
  if (err) throw new Error("文件已不在原位置。");
}

export async function revealInFinder(filePath: string): Promise<void> {
  await access(filePath);
  shell.showItemInFolder(filePath);
}
