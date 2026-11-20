import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "application/pdf": "pdf",
};
// Cloud's screenshot links expire after 24 h; keep files as long.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * fork: Cloud uploads screenshots and PDFs to a bucket and returns URLs. Here
 * they are written to FORK_FILES_DIR (bind-mounted from the host) and served
 * by the `files` container at FORK_FILES_URL. The host path is returned too,
 * because Claude Code can read a local file but cannot fetch a localhost URL.
 * Without FORK_FILES_DIR and FORK_FILES_URL the data URL is returned as is.
 */
export async function storeDataUrl(
  dataUrl: string,
): Promise<{ url: string; hostPath?: string }> {
  const dir = process.env.FORK_FILES_DIR;
  const base = process.env.FORK_FILES_URL?.replace(/\/$/, "");
  const match = /^data:([^;,]+);base64,/.exec(dataUrl);
  const ext = match ? EXTENSIONS[match[1]] : undefined;
  if (!dir || !base || !match || !ext) return { url: dataUrl };

  await mkdir(dir, { recursive: true });
  void sweep(dir);
  const name = `${randomUUID()}.${ext}`;
  await writeFile(
    path.join(dir, name),
    Buffer.from(dataUrl.slice(match[0].length), "base64"),
  );
  const hostDir = process.env.FORK_FILES_HOST_DIR;
  return {
    url: `${base}/${name}`,
    ...(hostDir ? { hostPath: path.join(hostDir, name) } : {}),
  };
}

// ponytail: sweeps on each write; a scheduled job if files ever pile up idle.
async function sweep(dir: string) {
  try {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const name of await readdir(dir)) {
      const file = path.join(dir, name);
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
    }
  } catch {
    // A failed sweep only means old files stay a little longer.
  }
}
