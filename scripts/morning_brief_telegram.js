#!/usr/bin/env node

import "dotenv/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrief, saveSession } from "../src/core/morning.js";
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

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function formatSymbolBrief(item, generatedAt) {
  if (item.error) {
    return `${item.symbol} | ERROR: ${item.error}`;
  }

  const indicators = item.indicators || {};
  const indicatorMap = getStudyValuesMap(indicators);
  const levels = detectLevels(indicators);
  const daily = biasWord(indicatorMap.AI_DAILY_BIAS);
  const weekly = biasWord(indicatorMap.AI_WEEKLY_BIAS);
  const aligned = daily === weekly && daily !== "中性";
  const bars = item.ohlcv?.bars || [];
  const fakeout = summarizeYesterdayFakeouts(
    bars,
    levels,
    indicatorMap.AI_DAILY_BIAS,
    indicatorMap.AI_WEEKLY_BIAS,
  );
  const reminder = getTodayReminder(
    levels,
    indicatorMap.AI_WEEKLY_BIAS,
    indicatorMap.AI_DAILY_BIAS,
  );

  return [
    `${item.symbol} | 週偏見${weekly} | 日偏見${daily} | ${aligned ? "方向一致" : "方向不一致"}`,
    `時間 ${new Date(generatedAt).toLocaleString("en-GB", { timeZone: "Australia/Brisbane" })} Brisbane`,
    fakeout,
    reminder,
    `PD ${formatPrice(levels.pd.poc)}/${formatPrice(levels.pd.vah)}/${formatPrice(levels.pd.val)} | ` +
      `2D ${formatPrice(levels.d2.poc)}/${formatPrice(levels.d2.vah)}/${formatPrice(levels.d2.val)} | ` +
      `PW ${formatPrice(levels.pw.poc)}/${formatPrice(levels.pw.vah)}/${formatPrice(levels.pw.val)} | ` +
      `2W ${formatPrice(levels.w2.poc)}/${formatPrice(levels.w2.vah)}/${formatPrice(levels.w2.val)}`,
  ].join("\n");
}

function formatBrief(result) {
  const rows = [];
  rows.push(`Morning brief ${new Date(result.generated_at).toLocaleString("en-GB", { timeZone: "Australia/Brisbane" })} Brisbane`);

  for (const item of result.symbols_scanned || []) {
    if (item.error) {
      rows.push(`${item.symbol} | ERROR: ${item.error}`);
      continue;
    }

    const indicators = item.indicators || {};
    const indicatorMap = getStudyValuesMap(indicators);
    const levels = detectLevels(indicators);
    const daily = biasWord(indicatorMap.AI_DAILY_BIAS);
    const weekly = biasWord(indicatorMap.AI_WEEKLY_BIAS);
    const aligned = daily === weekly && daily !== "中性";
    const bars = item.ohlcv?.bars || [];
    const fakeout = summarizeYesterdayFakeouts(
      bars,
      levels,
      indicatorMap.AI_DAILY_BIAS,
      indicatorMap.AI_WEEKLY_BIAS,
    );
    const reminder = getTodayReminder(
      levels,
      indicatorMap.AI_WEEKLY_BIAS,
      indicatorMap.AI_DAILY_BIAS,
    );

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
  const brief = await runBrief({ rules_path: rulesPath });

  const telegram = getTelegramConfigForKind(process.env, "morning");

  if (!telegram.enabled) {
    console.error("Telegram config missing. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_IDS (or TELEGRAM_CHAT_ID).");
    console.log(formatBrief(brief));
    process.exit(1);
  }

  const sent = [];
  for (const item of brief.symbols_scanned || []) {
    const text = formatSymbolBrief(item, brief.generated_at);
    const result = await sendTelegramBroadcast({
      botToken: telegram.botToken,
      chatIds: telegram.chatIds,
      text,
    });
    sent.push({ symbol: item.symbol, sent_to: result.sent_to });
  }

  await saveSession({ brief: formatBrief(brief) });

  console.log(JSON.stringify({
    success: true,
    sent_to: sent,
    rules_path: rulesPath,
  }, null, 2));
}

await main();
