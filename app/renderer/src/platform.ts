// True when the renderer is served remotely over HTTPS to a browser, rather
// than running inside the Electron window. The web server also sets
// `PDF_QA_REMOTE`, but CSP can block inline scripts in some browser paths, so
// the absence of the Electron preload bridge is the reliable fallback.
export const IS_REMOTE =
  (window as unknown as { PDF_QA_REMOTE?: boolean }).PDF_QA_REMOTE === true ||
  !window.pdfQaApp;

export const IS_MAC = window.pdfQaApp?.platform === "darwin";
export const IS_WINDOWS = window.pdfQaApp?.platform === "win32";
export const SEP = IS_WINDOWS ? " - " : " · ";
export const LEADING_SEP = IS_WINDOWS ? "- " : "· ";

export function platformText(label: string): string {
  return IS_WINDOWS ? label.replace(/\s*·\s*/g, " - ") : label;
}
