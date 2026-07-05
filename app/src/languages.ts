/**
 * Curated OCR languages a library can be set to. The `code` is a Tesseract
 * language identifier (the value stored per-collection and passed to the backend
 * as OCR_LANG); the `label` is what the UI shows. Shared by the main process
 * (writes the setting, sets the env) and the renderer (the pickers).
 *
 * Keep this list in sync with the default PDF_QA_BUNDLE_LANGS in
 * scripts/vendor-tesseract.sh — a code offered here only actually OCRs in a
 * packaged build if its <code>.traineddata is bundled. "osd" (orientation) is
 * always bundled but is not a user-selectable content language.
 */
export interface OcrLanguage {
  code: string;   // Tesseract lang id, e.g. "deu"
  label: string;  // human name shown in the UI
}

export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: "eng", label: "English" },
  { code: "deu", label: "German" },
  { code: "fra", label: "French" },
  { code: "spa", label: "Spanish" },
  { code: "ita", label: "Italian" },
  { code: "por", label: "Portuguese" },
  { code: "nld", label: "Dutch" },
  { code: "rus", label: "Russian" },
  { code: "ara", label: "Arabic" },
  { code: "chi_sim", label: "Chinese (Simplified)" },
  { code: "chi_tra", label: "Chinese (Traditional)" },
  { code: "jpn", label: "Japanese" },
  { code: "kor", label: "Korean" },
];

// Falls back to Tesseract's own default; the backend uses "eng" when OCR_LANG is
// unset, so an empty stored language means "English / inherit the env default".
export const DEFAULT_OCR_LANGUAGE = "eng";

const _CODES = new Set(OCR_LANGUAGES.map((l) => l.code));

/** True if `code` is one of the languages we offer (and bundle). */
export function isKnownOcrLanguage(code: string): boolean {
  return _CODES.has(code);
}

/** The display label for a code, or the code itself if unrecognized. */
export function ocrLanguageLabel(code: string): string {
  return OCR_LANGUAGES.find((l) => l.code === code)?.label ?? code;
}
