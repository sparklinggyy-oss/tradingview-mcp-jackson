#!/usr/bin/env node

import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrief } from "../src/core/morning.js";
import {
  appendFakeoutEvent,
  brisbaneDateString,
  brisbaneTimestampString,
} from "../src/core/fakeout_log.js";
import {
  detectLevels,
  formatPrice,
  getAlertPlan,
  getStudyValuesMap,
  isAfterBrisbaneHour,
  toNum,
} from "../src/core/brief_levels.js";
import {
  getTelegramConfigForKind,
  sendTelegramBroadcast,
} from "../src/core/telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(process.env.TMPDIR || "/private/tmp", "tradingview-mcp");
const STATE_PATH = resolve(STATE_DIR, "realtime-alert-state.json");
const DEFAULT_INTERVAL_MS = Number(process.env.ALERT_WATCH_INTERVAL_MS || 60000);
const MAX_SEEN_KEYS = Number(process.env.ALERT_WATCH_STATE_LIMIT || 5000);
const DEFAULT_WATCHER_SYMBOL_SWITCH_DELAY_MS = Number(
  process.env.TV_WATCHER_SYMBOL_SWITCH_DELAY_MS || 0,
);

function loadRulesPath() {
  const argIndex = process.argv.findIndex(
    (arg) => arg === "--rules" || arg === "-r",
  );
  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    return resolve(process.argv[argIndex + 1]);
  }
  return resolve(__dirname, "..", "rules.json");
}

function loadState() {
  if (!existsSync(STATE_PATH)) return { seen: {} };
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { seen: {} };
  } catch {
    return { seen: {} };
  }
}

function saveState(state) {
  const seenEntries = Object.entries(state.seen || {})
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .slice(-MAX_SEEN_KEYS);
  const normalized = {
    ...state,
    seen: Object.fromEntries(seenEntries),
  };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(normalized, null, 2));
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function latestClosedBar(bars) {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  return bars[bars.length - 2];
}

function toDateMillis(value) {
  const num = toNum(value);
  if (num === null) return Date.now();
  return num < 1e12 ? num * 1000 : num;
}

function eventKey(symbol, hit, bar) {
  const barTime = bar?.time ?? bar?.timestamp ?? "";
  return [
    symbol || "(unknown)",
    hit.label || "(unknown)",
    hit.mode || "(unknown)",
    barTime,
  ].join("|");
}

function groupHits(hits) {
  const groups = new Map();
  for (const hit of hits) {
    const key = hit.opportunity || "機會";
    const list = groups.get(key) || [];
    list.push(hit);
    groups.set(key, list);
  }
  return groups;
}

function isCurrentLevelHit(hit) {
  const label = String(hit?.label || "").trim();
  return label.startsWith("今日") || label.toLowerCase().includes("current");
}

function displayHitLabel(hit) {
  const label = String(hit?.label || "").trim();
  if (!label) return "";
  if (/^今日\s+VAH$/i.test(label)) return "Current VAH";
  if (/^今日\s+VAL$/i.test(label)) return "Current VAL";
  return label.replace(/^今日\s+/i, "Current ");
}

function resolveAiVpSnapshot(item) {
  const snapshot = item?.ai_vp || null;
  if (!snapshot || typeof snapshot !== "object") return null;
  if (!snapshot.levels || !snapshot.values) return null;
  return snapshot;
}

function buildAlertText(item, indicatorMap, levels, hits, bar) {
  const daily = indicatorMap.AI_DAILY_BIAS;
  const weekly = indicatorMap.AI_WEEKLY_BIAS;
  const dailyWord = toNum(daily) === 1 ? "多頭" : toNum(daily) === -1 ? "空頭" : "中性";
  const weeklyWord = toNum(weekly) === 1 ? "多頭" : toNum(weekly) === -1 ? "空頭" : "中性";
  const aligned = dailyWord === weeklyWord && dailyWord !== "中性";
  const q = item.quote || {};
  const price = isFiniteNumber(q.last) ? q.last : isFiniteNumber(q.close) ? q.close : null;
  const triggerSummary = hits.map(displayHitLabel).filter(Boolean).join(" / ");
  const groups = groupHits(hits);
  const currentHits = hits.filter(isCurrentLevelHit);
  const historicalHits = hits.filter((hit) => !isCurrentLevelHit(hit));
  const hasCurrentHit = currentHits.length > 0;
  const confidenceNote = hasCurrentHit
    ? (isAfterBrisbaneHour(17)
        ? "註：本訊號涉及 Developing Current VAH/VAL，17:00 Brisbane 後參考價值較高。"
        : "註：本訊號涉及 Developing Current VAH/VAL，17:00 Brisbane 前僅作低權重觀察；PD/2D/PW/2W 仍正常有效。")
    : "註：本訊號僅涉及 PD/2D/PW/2W 等固定位，正常有效。";

  const lines = [
    `${item.symbol}`,
    `週偏見${weeklyWord} / 日偏見${dailyWord}${aligned ? "，方向一致" : "，方向不一致"}`,
    price === null ? null : `現價 ${formatPrice(price)}`,
    `已 fakeout ${triggerSummary}，請人工盯盤。`,
    hasCurrentHit && !isAfterBrisbaneHour(17) ? "觀察級：Current VAH/VAL 低權重" : null,
  ].filter(Boolean);

  for (const [opportunity, list] of groups.entries()) {
    const labels = list.map(displayHitLabel).filter(Boolean).join(" / ");
    lines.push(`${opportunity}: ${labels}`);
  }

  if (bar) {
    lines.push(`觸發K線 ${new Date(toDateMillis(bar.time || bar.timestamp)).toLocaleString("en-GB", { timeZone: "Australia/Brisbane" })} Brisbane`);
  }

  lines.push(`PD ${formatPrice(levels.pd.poc)}/${formatPrice(levels.pd.vah)}/${formatPrice(levels.pd.val)}`);
  lines.push(`2D ${formatPrice(levels.d2.poc)}/${formatPrice(levels.d2.vah)}/${formatPrice(levels.d2.val)}`);
  lines.push(`PW ${formatPrice(levels.pw.poc)}/${formatPrice(levels.pw.vah)}/${formatPrice(levels.pw.val)}`);
  lines.push(`2W ${formatPrice(levels.w2.poc)}/${formatPrice(levels.w2.vah)}/${formatPrice(levels.w2.val)}`);
  lines.push(confidenceNote);

  return lines.join("\n");
}

function toFakeoutEvents(item, indicatorMap, levels, hits, bar) {
  const daily = toNum(indicatorMap.AI_DAILY_BIAS);
  const weekly = toNum(indicatorMap.AI_WEEKLY_BIAS);
  const snapshotSource = item?.ai_vp?.source || "data_window";
  const barTime = bar?.time ?? bar?.timestamp ?? null;

  return hits.map((hit) => ({
    symbol: item.symbol,
    date: brisbaneDateString(barTime || new Date()),
    session: brisbaneDateString(barTime || new Date()),
    level_set: hit.label.includes("CUR") ? "CUR" : hit.label.split(" ")[0],
    level_side: hit.mode === "val" ? "VAL" : "VAH",
    level_price: formatPrice(hit.level),
    event_type: "fakeout",
    trigger: "sweep_and_reclaim",
    opportunity: hit.opportunity,
    daily_bias_raw: daily,
    weekly_bias_raw: weekly,
    bar_time: barTime,
    brisbane_time: brisbaneTimestampString(barTime),
    source_snapshot: snapshotSource,
    label: hit.label,
    confidence: isCurrentLevelHit(hit) && !isAfterBrisbaneHour(17) ? "low" : "normal",
  }));
}

function collectHits(item) {
  const indicators = item.indicators || {};
  const aiVp = resolveAiVpSnapshot(item);
  const indicatorMap = aiVp?.values || getStudyValuesMap(indicators);
  const levels = aiVp?.levels || detectLevels(indicators);
  const plan = getAlertPlan(levels, indicatorMap.AI_WEEKLY_BIAS, indicatorMap.AI_DAILY_BIAS);
  const bar = latestClosedBar(item.ohlcv?.bars || []);

  if (!bar) {
    return { indicatorMap, levels, bar: null, hits: [] };
  }

  const hits = [];
  for (const entry of plan) {
    const level = toNum(entry.level);
    if (level === null) continue;
    const touched =
      entry.mode === "val"
        ? toNum(bar.low) <= level && toNum(bar.close) > level
        : entry.mode === "vah"
          ? toNum(bar.high) >= level && toNum(bar.close) < level
          : false;
    if (touched) hits.push(entry);
  }

  return { indicatorMap, levels, bar, hits };
}

async function scanOnce(state, telegram, rulesPath) {
  const brief = await runBrief({
    rules_path: rulesPath,
    symbol_switch_delay_ms: DEFAULT_WATCHER_SYMBOL_SWITCH_DELAY_MS,
  });
  const fired = [];

  for (const item of brief.symbols_scanned || []) {
    if (item.error) {
      console.warn(`[watcher] ${item.symbol}: ${item.error}`);
      continue;
    }

    const { indicatorMap, levels, bar, hits } = collectHits(item);
    const newHits = hits.filter((hit) => {
      const key = eventKey(item.symbol, hit, bar);
      if (state.seen[key]) return false;
      state.seen[key] = Date.now();
      return true;
    });

    if (!newHits.length) continue;

    const text = buildAlertText(item, indicatorMap, levels, newHits, bar);
    for (const event of toFakeoutEvents(item, indicatorMap, levels, newHits, bar)) {
      appendFakeoutEvent(event);
    }
    await sendTelegramBroadcast({
      botToken: telegram.botToken,
      chatIds: telegram.chatIds,
      text,
    });

    saveState(state);
    fired.push({
      symbol: item.symbol,
      hits: newHits.map((hit) => hit.label),
    });
  }
  return fired;
}

async function main() {
  const rulesPath = loadRulesPath();
  const telegram = getTelegramConfigForKind(process.env, "alerts");

  if (!telegram.enabled) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_IDS");
  }

  const state = loadState();
  console.log(`[watcher] starting. interval=${DEFAULT_INTERVAL_MS}ms rules=${rulesPath}`);

  let consecutiveErrors = 0;
  while (true) {
    try {
      const fired = await scanOnce(state, telegram, rulesPath);
      consecutiveErrors = 0;
      if (fired.length) {
        console.log(`[watcher] fired ${fired.length} symbol(s)`);
      }
    } catch (err) {
      consecutiveErrors += 1;
      console.error(`[watcher] scan failed (${consecutiveErrors}): ${err.message}`);
      if (consecutiveErrors >= 3) {
        throw err;
      }
    }

    await new Promise((r) => setTimeout(r, DEFAULT_INTERVAL_MS));
  }
}

await main();
