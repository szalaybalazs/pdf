// Shared by BOTH the main process and the renderer bundle — keep it free of
// Node-only globals like `process` (the renderer has no `process`). Analytics
// config (which reads process.env) lives in the main-only analytics.ts.
export const APP_NAME = "PDF QA";
