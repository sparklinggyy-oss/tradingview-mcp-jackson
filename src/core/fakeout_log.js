import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FAKEOUTS_DIR = join(homedir(), ".tradingview-mcp", "fakeouts");

function brisbaneDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return { year, month, day };
}

export function brisbaneDateString(date = new Date()) {
  const { year, month, day } = brisbaneDateParts(date);
  return `${year}-${month}-${day}`;
}

export function previousBrisbaneDateString(reference = new Date()) {
  const { year, month, day } = brisbaneDateParts(reference);
  const utc = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

export function brisbaneTimestampString(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
}

export function appendFakeoutEvent(event) {
  const dateStr =
    event?.date ||
    event?.brisbane_date ||
    brisbaneDateString(event?.bar_time || event?.event_time || new Date());

  mkdirSync(FAKEOUTS_DIR, { recursive: true });
  const filePath = join(FAKEOUTS_DIR, `${dateStr}.jsonl`);
  const record = {
    ...event,
    date: dateStr,
    saved_at: new Date().toISOString(),
  };

  appendFileSync(filePath, `${JSON.stringify(record)}\n`);
  return { success: true, path: filePath, date: dateStr };
}

export function loadFakeoutEvents({ date } = {}) {
  const dateStr = date || brisbaneDateString(new Date());
  const filePath = join(FAKEOUTS_DIR, `${dateStr}.jsonl`);
  if (!existsSync(filePath)) {
    return { success: true, date: dateStr, events: [], path: filePath };
  }

  const lines = readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const events = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch (_) {}
  }

  return { success: true, date: dateStr, events, path: filePath };
}

export function groupFakeoutEventsBySymbol(events) {
  const groups = {};
  for (const event of Array.isArray(events) ? events : []) {
    const symbol = String(event?.symbol || "").trim();
    if (!symbol) continue;
    if (!groups[symbol]) groups[symbol] = [];
    groups[symbol].push(event);
  }
  return groups;
}

