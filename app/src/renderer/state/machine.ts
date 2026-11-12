import type { AppScreen } from "../../shared/types";

export type { AppScreen };

export function showScreen(id: AppScreen): void {
  for (const el of document.querySelectorAll<HTMLElement>(".screen")) {
    el.classList.toggle("active", el.id === id);
  }
}
