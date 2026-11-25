import { randomUUID } from "node:crypto";
import { open, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";

// Magpie can run more than one process that loads plugins (the window's
// gateway host, a CLI that lists providers, a restarted host). Only one of
// them should publish or apply WorkBuddy snapshots on this computer. The
// lock names its holder. Unlike upstream, never take over a live holder.
export async function acquireEngineLock(dir) {
  const file = join(dir, "workbuddy-sync.lock");
  const me = JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now(), nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, "wx", 0o600);
      await handle.writeFile(me);
      await handle.close();
      return async () => {
        try {
          if ((await readFile(file, "utf8")) === me) await rm(file, { force: true });
        } catch {}
      };
    } catch (e) {
      if (!["EEXIST", "EPERM", "EACCES"].includes(e?.code)) throw e;
    }
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    let holder;
    try {
      holder = JSON.parse(await readFile(file, "utf8"));
    } catch {}
    if (holder?.host && holder.host !== hostname()) return null;
    if (Number.isInteger(holder?.pid) && holder.pid > 0) {
      try {
        process.kill(holder.pid, 0);
        return null;
      } catch (e) {
        if (e?.code !== "ESRCH") return null;
      }
    } else if (Date.now() - info.mtimeMs < 10_000) return null;
    const latest = await stat(file).catch(() => null);
    if (latest?.ino === info.ino && latest?.mtimeMs === info.mtimeMs) await rm(file, { force: true }).catch(() => {});
  }
  return null;
}
