#!/usr/bin/env node

import "dotenv/config";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { list as listAlerts } from "../src/core/alerts.js";
import { getTelegramConfigForKind, sendTelegramBroadcast } from "../src/core/telegram.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(process.env.TMPDIR || "/private/tmp", "tradingview-mcp");
const STATE_PATH = resolve(STATE_DIR, "alert-router-state.json");

function loadState() {
  if (!existsSync(STATE_PATH)) return { seen: {} };
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { seen: {} }; }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function toKey(alert) {
  return `${alert.alert_id}:${alert.last_fired || alert.created || ""}`;
}

function loadSetupState() {
  const setupPath = resolve(STATE_DIR, "alert-setup-state.json");
  if (!existsSync(setupPath)) return { created: [] };
  try { return JSON.parse(readFileSync(setupPath, "utf8")); } catch { return { created: [] }; }
}

function buildTrackedMap(setupState) {
  const map = new Map();
  for (const entry of setupState.created || []) {
    if (!entry) continue;
    if (entry.alert_id != null) {
      map.set(String(entry.alert_id), entry);
    }
  }
  return map;
}

function shouldForward(alert, trackedMap) {
  if (trackedMap.has(String(alert?.alert_id || ""))) return true;
  return String(alert?.message || "").startsWith("[AI-VP]");
}

function formatFiredText(alert, trackedEntry) {
  if (trackedEntry) {
    return [
      `${trackedEntry.symbol || alert.symbol || '(unknown symbol)'}`,
      `週偏見${trackedEntry.weekly_bias || ''} / 日偏見${trackedEntry.daily_bias || ''}`.replace(/\s+\/\s+/g, ' / ').trim(),
      trackedEntry.alignment || '',
      `${trackedEntry.label || 'Level'} ${trackedEntry.price || ''} 已觸及，請人工盯盤尋找${trackedEntry.opportunity || '機會'}`,
      `Last fired: ${alert.last_fired || '(unknown)'}`,
    ].filter(Boolean).join('\n');
  }

  return [
    `ALERT FIRED`,
    `${alert.symbol || '(unknown symbol)'}`,
    alert.message || '(no message)',
    `Condition: ${alert.condition || '(unknown)'}`,
    `Last fired: ${alert.last_fired || '(unknown)'}`,
  ].join('\n');
}

async function main() {
  const telegram = getTelegramConfigForKind(process.env, "alerts");
  if (!telegram.enabled) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_IDS");
  }

  const pollMs = Number(process.argv.find((a) => a.startsWith("--interval="))?.split("=")[1] || 15000);
  const state = loadState();
  const setupState = loadSetupState();
  const trackedMap = buildTrackedMap(setupState);

  while (true) {
    const result = await listAlerts();
    const alerts = result.alerts || [];
    const fired = [];

    for (const alert of alerts) {
      if (!alert.last_fired) continue;
      if (!shouldForward(alert, trackedMap)) continue;
      const key = toKey(alert);
      if (state.seen[key]) continue;
      fired.push(alert);
      state.seen[key] = true;
    }

    if (fired.length > 0) {
      for (const alert of fired) {
        const trackedEntry = trackedMap.get(String(alert.alert_id || ""));
        const text = formatFiredText(alert, trackedEntry);
        await sendTelegramBroadcast({
          botToken: telegram.botToken,
          chatIds: telegram.chatIds,
          text,
        });
      }
      saveState(state);
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}

await main();
