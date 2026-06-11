#!/usr/bin/env node

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runBrief } from "../src/core/morning.js";
import { setSymbol, setTimeframe } from "../src/core/chart.js";
import * as alerts from "../src/core/alerts.js";
import {
  extractVpLevels,
  formatPrice,
} from "../src/core/vp_levels.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const STATE_DIR = resolve(process.env.TMPDIR || "/private/tmp", "tradingview-mcp");
const STATE_PATH = resolve(STATE_DIR, "alert-setup-state.json");

function loadRulesPath() {
  const argIndex = process.argv.findIndex((arg) => arg === "--rules" || arg === "-r");
  if (argIndex >= 0 && process.argv[argIndex + 1]) return resolve(process.argv[argIndex + 1]);
  return resolve(PROJECT_ROOT, "rules.json");
}

function readState() {
  if (!existsSync(STATE_PATH)) return { created: [] };
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { created: [] }; }
}

function writeState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function buildMessage({ symbol, levels, label, levelValue, opportunity }) {
  const aligned = levels.bias.weekly === levels.bias.daily && levels.bias.daily !== "中性";
  return [
    "[AI-VP]",
    symbol,
    `週偏見${levels.bias.weekly} / 日偏見${levels.bias.daily}`,
    aligned ? "方向一致" : "方向不一致",
    `${label} ${formatPrice(levelValue)} 已觸及，請人工盯盤尋找${opportunity}`,
  ].join(" | ");
}

function getAlertPlan(levels) {
  const daily = levels.bias.daily;
  const weekly = levels.bias.weekly;

  const trendLong = () => ([
    { label: "PD VAL", level: levels.pd.val, opportunity: "多單機會" },
    { label: "2D VAL", level: levels.d2.val, opportunity: "多單機會" },
    { label: "PW VAL", level: levels.pw.val, opportunity: "多單機會" },
    { label: "2W VAL", level: levels.w2.val, opportunity: "多單機會" },
  ]);

  const trendShort = () => ([
    { label: "PD VAH", level: levels.pd.vah, opportunity: "空單機會" },
    { label: "2D VAH", level: levels.d2.vah, opportunity: "空單機會" },
    { label: "PW VAH", level: levels.pw.vah, opportunity: "空單機會" },
    { label: "2W VAH", level: levels.w2.vah, opportunity: "空單機會" },
  ]);

  const counterWeekShort = () => ([
    { label: "今日 VAH", level: levels.cur.vah, opportunity: "短空機會" },
  ]);

  const counterWeekLong = () => ([
    { label: "今日 VAL", level: levels.cur.val, opportunity: "短多機會" },
  ]);

  const reversalLong = () => ([
    { label: "PD VAL", level: levels.pd.val, opportunity: "大級別反轉多單機會" },
    { label: "2D VAL", level: levels.d2.val, opportunity: "大級別反轉多單機會" },
    { label: "PW VAL", level: levels.pw.val, opportunity: "大級別反轉多單機會" },
    { label: "2W VAL", level: levels.w2.val, opportunity: "大級別反轉多單機會" },
  ]);

  const reversalShort = () => ([
    { label: "PD VAH", level: levels.pd.vah, opportunity: "大級別反轉空單機會" },
    { label: "2D VAH", level: levels.d2.vah, opportunity: "大級別反轉空單機會" },
    { label: "PW VAH", level: levels.pw.vah, opportunity: "大級別反轉空單機會" },
    { label: "2W VAH", level: levels.w2.vah, opportunity: "大級別反轉空單機會" },
  ]);

  if (weekly === "多頭" && daily === "多頭") return trendLong();
  if (weekly === "空頭" && daily === "空頭") return trendShort();
  if (weekly === "多頭" && daily === "空頭") return [...counterWeekShort(), ...reversalLong()];
  if (weekly === "空頭" && daily === "多頭") return [...counterWeekLong(), ...reversalShort()];
  return [];
}

async function main() {
  const rulesPath = loadRulesPath();
  const brief = await runBrief({ rules_path: rulesPath });
  const timeframe = brief?.symbols_scanned?.[0]?.timeframe || "5";
  const existing = await alerts.list().catch(() => ({ alerts: [] }));
  const existingAlerts = existing.alerts || [];
  const created = [];
  const skipped = [];

  for (const item of brief.symbols_scanned || []) {
    if (item.error) {
      skipped.push({ symbol: item.symbol, reason: item.error });
      continue;
    }

    const levels = extractVpLevels(item.indicators);
    const plan = getAlertPlan(levels);
    if (plan.length === 0) {
      skipped.push({ symbol: item.symbol, reason: `no alert plan for bias (${levels.bias.weekly}/${levels.bias.daily})` });
      continue;
    }

    for (const target of plan) {
      const levelValue = Number(String(target.level).replace(/,/g, "").replace(/[−–—]/g, "-"));
      if (!Number.isFinite(levelValue)) continue;

      const formattedPrice = formatPrice(levelValue);
      const alreadyExists = existingAlerts.some((alert) => {
        if (alert.symbol !== item.symbol) return false;
        const alertPrice = Number(String(alert?.condition?.series?.[1]?.value ?? "").replace(/,/g, "").replace(/[−–—]/g, "-"));
        return Number.isFinite(alertPrice) && Math.abs(alertPrice - levelValue) < 1e-9;
      });
      if (alreadyExists) continue;

      const message = buildMessage({
        symbol: item.symbol,
        levels,
        label: target.label,
        levelValue,
        opportunity: target.opportunity,
      });

      await setSymbol({ symbol: item.symbol });
      await setTimeframe({ timeframe });
      const before = await alerts.list().catch(() => ({ alerts: [] }));
      const beforeIds = new Set((before.alerts || []).map((alert) => alert.alert_id));
      await alerts.create({
        condition: "crossing",
        price: levelValue,
        message,
      });

      const after = await alerts.list().catch(() => ({ alerts: [] }));
      const newAlert = (after.alerts || []).find((alert) =>
        !beforeIds.has(alert.alert_id)
        && alert.symbol === item.symbol
        && Number(String(alert?.condition?.series?.[1]?.value ?? "").replace(/,/g, "")) === levelValue
      ) || null;

      const alertId = newAlert?.alert_id || null;
      existingAlerts.push({
        alert_id: alertId,
        symbol: item.symbol,
        price: formattedPrice,
        label: target.label,
        opportunity: target.opportunity,
        weekly_bias: levels.bias.weekly,
        daily_bias: levels.bias.daily,
        alignment: levels.bias.weekly === levels.bias.daily && levels.bias.daily !== "中性" ? "方向一致" : "方向不一致",
        message,
      });
      created.push({
        alert_id: alertId,
        symbol: item.symbol,
        label: target.label,
        price: formattedPrice,
        opportunity: target.opportunity,
        weekly_bias: levels.bias.weekly,
        daily_bias: levels.bias.daily,
        alignment: levels.bias.weekly === levels.bias.daily && levels.bias.daily !== "中性" ? "方向一致" : "方向不一致",
      });
    }
  }

  writeState({
    saved_at: new Date().toISOString(),
    rules_path: rulesPath,
    created,
  });

  console.log(JSON.stringify({
    success: true,
    created_count: created.length,
    skipped_count: skipped.length,
    created,
    skipped,
    state_path: STATE_PATH,
  }, null, 2));
}

await main();
