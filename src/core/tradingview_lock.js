import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCK_DIR = resolve(process.env.TMPDIR || "/private/tmp", "tradingview-mcp");
const LOCK_PATH = resolve(LOCK_DIR, "tv-session.lock");
const DEFAULT_STALE_MS = Number(process.env.TV_LOCK_STALE_MS || 15 * 60 * 1000);

function readLockMeta() {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

function writeLockMeta(meta) {
  mkdirSync(LOCK_DIR, { recursive: true });
  writeFileSync(LOCK_PATH, JSON.stringify(meta, null, 2));
}

function removeLock() {
  try {
    unlinkSync(LOCK_PATH);
  } catch {}
}

export async function acquireTradingViewLock({
  name = "tradingview",
  waitMs = 0,
  staleMs = DEFAULT_STALE_MS,
  pollMs = 1000,
} = {}) {
  const started = Date.now();

  while (true) {
    const current = readLockMeta();
    if (current) {
      const age = Date.now() - Number(current.acquired_at || 0);
      if (Number.isFinite(age) && age > staleMs) {
        removeLock();
      }
    }

    try {
      writeLockMeta({
        name,
        pid: process.pid,
        acquired_at: Date.now(),
        host: process.env.HOSTNAME || null,
      });
      return async () => {
        const latest = readLockMeta();
        if (latest && Number(latest.pid) === process.pid) {
          removeLock();
        }
      };
    } catch (err) {
      if (Date.now() - started >= waitMs) {
        throw new Error(
          `TradingView session is busy (lock held at ${LOCK_PATH}).`,
        );
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

export async function withTradingViewLock(fn, opts = {}) {
  const release = await acquireTradingViewLock(opts);
  try {
    return await fn();
  } finally {
    await release();
  }
}
