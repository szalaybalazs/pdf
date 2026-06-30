export const IS_MAC = window.pdfQaApp?.platform === "darwin";
export const IS_WINDOWS = window.pdfQaApp?.platform === "win32";
export const SEP = IS_WINDOWS ? " - " : " · ";
export const LEADING_SEP = IS_WINDOWS ? "- " : "· ";

export function platformText(label: string): string {
  return IS_WINDOWS ? label.replace(/\s*·\s*/g, " - ") : label;
}
