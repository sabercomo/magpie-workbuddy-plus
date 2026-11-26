// Adapted from WorkBuddy Sync's per-follower files. Keep only a generated
// device ID (in the filename), the observed time and the applied generation.
const heartbeatMs = 10 * 60_000, readMs = 2 * 60_000;
export const followerOfflineMs = 3 * heartbeatMs;
const deviceFile = /^([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\.json$/;
const maxDevices = 24;

function observation(file, now) {
  if (!file || file.data.length > 512) return null;
  const value = JSON.parse(file.data.toString("utf8"));
  const { seen, generation } = value || {};
  if (value?.version !== 1 || !Number.isSafeInteger(seen) || seen <= 0 || seen > now + readMs ||
      !Number.isSafeInteger(generation) || generation < 0) return null;
  return { seen, generation };
}

// null is not a follower; generation zero is a follower that has not applied a snapshot yet.
export async function syncPresence(store, snapshotPath, machine, now, applied, previous = {}) {
  const dir = snapshotPath.slice(0, snapshotPath.lastIndexOf("/")) + "/followers";
  const next = { ...previous };
  if (applied !== null && (!next.heartbeat || now - next.heartbeat.seen >= heartbeatMs) &&
      (!next.heartbeatAttempt || now - next.heartbeatAttempt >= readMs)) {
    next.heartbeatAttempt = now;
    try {
      const path = `${dir}/${machine}.json`, file = await store.read(path);
      let old;
      try { old = observation(file, now); } catch {}
      if (old && now - old.seen < heartbeatMs) next.heartbeat = old;
      else {
        const body = { version: 1, seen: now, generation: applied };
        await store.writeIf(path, Buffer.from(JSON.stringify(body)), "workbuddy-plus: follower heartbeat", file?.sha || null);
        next.heartbeat = { seen: now, generation: applied };
      }
      delete next.heartbeatFailed;
    } catch {
      next.heartbeatFailed = true;
    }
  }
  if (!next.checkedAt || now - next.checkedAt >= readMs) {
    next.checkedAt = now;
    try {
      const files = (await store.list(dir)).filter(({ name, size }) => deviceFile.test(name) && size <= 512).slice(0, maxDevices);
      const entries = await Promise.allSettled(files.map(async ({ name }) => {
        const observed = observation(await store.read(`${dir}/${name}`), now);
        return observed && { id: deviceFile.exec(name)[1], ...observed };
      }));
      next.followers = entries.flatMap(result => result.status === "fulfilled" && result.value ? [result.value] : []);
      next.unavailable = entries.some(result => result.status === "rejected");
    } catch {
      next.unavailable = true;
    }
  }
  return next;
}
