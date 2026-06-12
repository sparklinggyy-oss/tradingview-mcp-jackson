#!/usr/bin/env node

import "dotenv/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSession, runBrief, saveSession } from "../src/core/morning.js";
import {
  biasWord,
  detectLevels,
  formatPrice,
  getStudyValuesMap,
  getTodayReminder,
  summarizeYesterdayFakeouts,
} from "../src/core/brief_levels.js";
import {
  getTelegramConfigForKind,
  sendTelegramBroadcast,
} from "../src/core/telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

function loadRulesPath() {
  const argIndex = process.argv.findIndex(
    (arg) => arg === "--rules" || arg === "-r",
  );
  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    return resolve(process.argv[argIndex + 1]);
  }
  return resolve(PROJECT_ROOT, "rules.json");
}

function loadTargetDate() {
  const argIndex = process.argv.findIndex(
    (arg) => arg === "--date" || arg === "-d",
  );
  if (argIndex >= 0 && process.argv[argIndex + 1]) {
    const date = process.argv[argIndex + 1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Invalid --date value: ${date}. Use YYYY-MM-DD.`);
    }
    return date;
  }
  return null;
}

function hasFlag(flag) {
  return process.argv.some((arg) => arg === flag);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function resolveAiVpSnapshot(item) {
  const snapshot = item?.ai_vp || null;
  if (!snapshot || typeof snapshot !== "object") return null;
  if (!snapshot.levels || !snapshot.values) return null;
  return snapshot;
}

function debugAiVpSnapshot(item, sourceLabel = "ai_vp") {
  if (process.env.DEBUG_AI_VP !== "1") return;

  const snapshot = resolveAiVpSnapshot(item);
  if (!snapshot) {
    console.log(`[DEBUG_AI_VP] ${item?.symbol || "unknown"} ${sourceLabel}: unavailable`);
    return;
  }

  const v = snapshot.values || {};
  const d2 = {
    poc: v.AI_2D_POC ?? v.AI_3D_POC,
    vah: v.AI_2D_VAH ?? v.AI_3D_VAH,
    val: v.AI_2D_VAL ?? v.AI_3D_VAL,
  };

  console.log(
    `[DEBUG_AI_VP] ${item.symbol} ${sourceLabel}: ` +
    `daily=${snapshot.dailyBiasRaw} weekly=${snapshot.weeklyBiasRaw} | ` +
    `CUR=${v.AI_CUR_POC}/${v.AI_CUR_VAH}/${v.AI_CUR_VAL} | ` +
    `PD=${v.AI_PD_POC}/${v.AI_PD_VAH}/${v.AI_PD_VAL} | ` +
    `2D=${d2.poc}/${d2.vah}/${d2.val} | ` +
    `PW=${v.AI_PW_POC}/${v.AI_PW_VAH}/${v.AI_PW_VAL} | ` +
    `2W=${v.AI_2W_POC}/${v.AI_2W_VAH}/${v.AI_2W_VAL}`,
  );
}

function previousDateString(reference = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(reference));
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

function dateToBrisbaneString(date) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function timestampToBrisbaneString(ts) {
  if (ts === null || ts === undefined) return null;
  const n = Number(ts);
  if (!Number.isFinite(n)) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  return dateToBrisbaneString(ms);
}

function parseLevelSegment(segment) {
  const match = String(segment || "").trim().match(/^(PD|2D|PW|2W)\s+(.+)$/i);
  if (!match) return null;
  const label = match[1].toUpperCase();
  const values = match[2].split("/").map((s) => s.trim());
  if (values.length !== 3) return null;

  const keyMap = {
    PD: "pd",
    "2D": "d2",
    PW: "pw",
    "2W": "w2",
  };

  const key = keyMap[label];
  if (!key) return null;

  return {
    key,
    value: {
      poc: values[0],
      vah: values[1],
      val: values[2],
    },
  };
}

function parsePriorSessionLevels(briefText) {
  const map = {};
  const lines = String(briefText || "").split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("Morning brief")) continue;
    if (!line.includes(" | 週偏見")) continue;

    const symbol = line.split("|")[0].trim();
    let levelLine = "";
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (/^\S+\s+\|\s+週偏見/.test(candidate)) break;
      if (/^PD\s+/i.test(candidate) && candidate.includes(" | ")) {
        levelLine = candidate;
        break;
      }
    }

    if (!levelLine) continue;

    const segments = levelLine.split(" | ").map((s) => s.trim());
    if (segments.length < 4) continue;

    const parsed = {};
    let ok = true;
    for (const segment of segments.slice(0, 4)) {
      const item = parseLevelSegment(segment);
      if (!item) {
        ok = false;
        break;
      }
      parsed[item.key] = item.value;
    }

    if (ok && symbol) {
      map[symbol] = parsed;
    }
  }

  return map;
}

function buildSnapshotBySymbol(brief) {
  const snapshot = { generated_at: brief.generated_at, symbols: {} };
  for (const item of brief.symbols_scanned || []) {
    if (item.error) continue;
    const indicators = item.indicators || {};
    const bars = item.ohlcv?.bars || [];
    const firstBar = bars[0] || null;
    const lastBar = bars[bars.length - 1] || null;
    const aiVp = resolveAiVpSnapshot(item);
    const indicatorMap = aiVp?.values || getStudyValuesMap(indicators);
    snapshot.symbols[item.symbol] = {
      levels: aiVp?.levels || detectLevels(indicators),
      weeklyBiasRaw: indicatorMap.AI_WEEKLY_BIAS ?? null,
      dailyBiasRaw: indicatorMap.AI_DAILY_BIAS ?? null,
      weeklyBias: aiVp?.weeklyBias || biasWord(indicatorMap.AI_WEEKLY_BIAS),
      dailyBias: aiVp?.dailyBias || biasWord(indicatorMap.AI_DAILY_BIAS),
      generated_at: brief.generated_at,
      source: aiVp?.source || "data_window",
      ohlcv: {
        bar_count: bars.length,
        first_bar_time: firstBar?.time ?? null,
        last_bar_time: lastBar?.time ?? null,
        first_brisbane_date: timestampToBrisbaneString(firstBar?.time),
        last_brisbane_date: timestampToBrisbaneString(lastBar?.time),
      },
    };
  }
  return snapshot;
}

function levelsBySymbolFromSession(session) {
  const snapshot = session?.snapshot;
  const symbols = snapshot?.symbols && typeof snapshot.symbols === "object" ? snapshot.symbols : null;
  if (symbols) {
    const map = {};
    for (const [symbol, entry] of Object.entries(symbols)) {
      if (entry?.levels) map[symbol] = entry.levels;
    }
    return map;
  }
  return parsePriorSessionLevels(session?.brief || "");
}

function formatSymbolBrief(item, generatedAt, priorLevelsBySymbol = {}) {
  if (item.error) {
    return `${item.symbol} | ERROR: ${item.error}`;
  }

  const aiVp = resolveAiVpSnapshot(item);
  if (!aiVp) {
    return `${item.symbol} | ERROR: AI VP snapshot unavailable for ${item.symbol}`;
  }
  debugAiVpSnapshot(item, "formatSymbolBrief");

  const levels = aiVp.levels;
  const daily = aiVp.dailyBias || biasWord(aiVp.dailyBiasRaw);
  const weekly = aiVp.weeklyBias || biasWord(aiVp.weeklyBiasRaw);
  const aligned = daily === weekly && daily !== "中性";
  const bars = item.ohlcv?.bars || [];
  const fakeout = summarizeYesterdayFakeouts(
    bars,
    priorLevelsBySymbol[item.symbol] || levels,
    aiVp.dailyBiasRaw,
    aiVp.weeklyBiasRaw,
  );
  const reminder = getTodayReminder(
    levels,
    aiVp.weeklyBiasRaw,
    aiVp.dailyBiasRaw,
  );
  const yesterdayNote = "註：CUR/PD/2D/PW/2W 皆為昨日 session 內 AI VP Reader 數值";

  return [
    `${item.symbol} | 週偏見${weekly} | 日偏見${daily} | ${aligned ? "方向一致" : "方向不一致"}`,
    `時間 ${new Date(generatedAt).toLocaleString("en-GB", { timeZone: "Australia/Brisbane" })} Brisbane`,
    fakeout,
    yesterdayNote,
    reminder,
    `PD ${formatPrice(levels.pd.poc)}/${formatPrice(levels.pd.vah)}/${formatPrice(levels.pd.val)} | ` +
      `2D ${formatPrice(levels.d2.poc)}/${formatPrice(levels.d2.vah)}/${formatPrice(levels.d2.val)} | ` +
      `PW ${formatPrice(levels.pw.poc)}/${formatPrice(levels.pw.vah)}/${formatPrice(levels.pw.val)} | ` +
      `2W ${formatPrice(levels.w2.poc)}/${formatPrice(levels.w2.vah)}/${formatPrice(levels.w2.val)}`,
  ].join("\n");
}

function formatBrief(result, priorLevelsBySymbol = {}) {
  const rows = [];
  rows.push(`Morning brief ${new Date(result.generated_at).toLocaleString("en-GB", { timeZone: "Australia/Brisbane" })} Brisbane`);

  for (const item of result.symbols_scanned || []) {
    if (item.error) {
      rows.push(`${item.symbol} | ERROR: ${item.error}`);
      continue;
    }

    const aiVp = resolveAiVpSnapshot(item);
    if (!aiVp) {
      rows.push(`${item.symbol} | ERROR: AI VP snapshot unavailable for ${item.symbol}`);
      continue;
    }
    debugAiVpSnapshot(item, "formatBrief");

    const levels = aiVp.levels;
    const daily = aiVp.dailyBias || biasWord(aiVp.dailyBiasRaw);
    const weekly = aiVp.weeklyBias || biasWord(aiVp.weeklyBiasRaw);
    const aligned = daily === weekly && daily !== "中性";
    const bars = item.ohlcv?.bars || [];
    const fakeout = summarizeYesterdayFakeouts(
      bars,
      priorLevelsBySymbol[item.symbol] || levels,
      aiVp.dailyBiasRaw,
      aiVp.weeklyBiasRaw,
    );
    const reminder = getTodayReminder(
      levels,
      aiVp.weeklyBiasRaw,
      aiVp.dailyBiasRaw,
    );
    const yesterdayNote = "註：CUR/PD/2D/PW/2W 皆為昨日 session 內 AI VP Reader 數值";

    rows.push(
      [
        `${item.symbol}`,
        `週偏見${weekly}`,
        `日偏見${daily}`,
        aligned ? "方向一致" : "方向不一致",
      ]
        .filter(Boolean)
        .join(" | "),
    );
    rows.push(fakeout);
    rows.push(yesterdayNote);
    rows.push(reminder);
    rows.push(
      `PD ${formatPrice(levels.pd.poc)}/${formatPrice(levels.pd.vah)}/${formatPrice(levels.pd.val)} | ` +
        `2D ${formatPrice(levels.d2.poc)}/${formatPrice(levels.d2.vah)}/${formatPrice(levels.d2.val)} | ` +
        `PW ${formatPrice(levels.pw.poc)}/${formatPrice(levels.pw.vah)}/${formatPrice(levels.pw.val)} | ` +
        `2W ${formatPrice(levels.w2.poc)}/${formatPrice(levels.w2.vah)}/${formatPrice(levels.w2.val)}`,
    );
  }

  return rows.join("\n");
}

async function main() {
  const rulesPath = loadRulesPath();
  const captureOnly = hasFlag("--capture-only");
  const targetDate = loadTargetDate() || dateToBrisbaneString(new Date());
  const brief = await runBrief({ rules_path: rulesPath });
  const priorSession = getSession({ date: previousDateString(new Date(`${targetDate}T12:00:00Z`)) });
  const priorLevelsBySymbol = levelsBySymbolFromSession(priorSession);
  const snapshot = buildSnapshotBySymbol(brief);

  if (captureOnly) {
    const mismatches = [];
    for (const [symbol, entry] of Object.entries(snapshot.symbols || {})) {
      if (entry?.ohlcv?.last_brisbane_date && entry.ohlcv.last_brisbane_date !== targetDate) {
        mismatches.push({
          symbol,
          last_brisbane_date: entry.ohlcv.last_brisbane_date,
          bar_count: entry.ohlcv.bar_count,
        });
      }
    }
    if (mismatches.length > 0) {
      throw new Error(`capture-only date mismatch for ${targetDate}: ${JSON.stringify(mismatches.slice(0, 5))}`);
    }
  }

  const telegram = getTelegramConfigForKind(process.env, "morning");

  if (!telegram.enabled && !captureOnly) {
    console.error("Telegram config missing. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS (or TELEGRAM_CHAT_ID).");
    console.log(formatBrief(brief));
    process.exit(1);
  }

  const sent = [];
  if (!captureOnly) {
    for (const item of brief.symbols_scanned || []) {
      if (process.env.DEBUG_AI_VP === "1") {
        debugAiVpSnapshot(item, "main");
      }
      const text = formatSymbolBrief(item, brief.generated_at, priorLevelsBySymbol);
      const result = await sendTelegramBroadcast({
        botToken: telegram.botToken,
        chatIds: telegram.chatIds,
        text,
      });
      sent.push({ symbol: item.symbol, sent_to: result.sent_to });
    }
  }

  await saveSession({ brief: formatBrief(brief, priorLevelsBySymbol), snapshot, date: targetDate });

  console.log(JSON.stringify({
    success: true,
    capture_only: captureOnly,
    session_date: targetDate,
    sent_to: sent,
    rules_path: rulesPath,
  }, null, 2));
}

await main();
