import type { ExportMessage, ExportRequest } from '../core/export/export.worker';

/** Run an export in a dedicated worker; resolves with the file to save. */
export function runExport(
  req: ExportRequest,
  onProgress?: (done: number, total: number) => void,
): Promise<{ blob: Blob; filename: string; rows: number }> {
  const worker = new Worker(new URL('../core/export/export.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<ExportMessage>) => {
      const m = ev.data;
      if (m.type === 'progress') onProgress?.(m.done, m.total);
      else {
        worker.terminate();
        if (m.type === 'done') resolve({ blob: m.blob, filename: m.filename, rows: m.rows });
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'export worker failed'));
    };
    worker.postMessage(req);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
