/**
 * Morning brief core logic.
 * Reads rules.json, scans watchlist symbols, returns structured data
 * for Claude to apply bias criteria and generate a session brief.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "./chart.js";
import * as data from "./data.js";
import { getStudyValuesMap } from "./study_values.js";
import { extractAiVpSnapshotFromPineLabels } from "./study_values.js";
import { withTradingViewLock } from "./tradingview_lock.js";
import * as ui from "./ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");
const USER_DATA_DIR = resolve(join(homedir(), ".tradingview-mcp"));
const REQUIRED_STUDIES = String(
  process.env.TV_REQUIRED_STUDIES ||
    "AI VP Reader - Full Bias Levels,Session Volume Profile,Absorption Bubbles",
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RECOVERY_LAYOUT = process.env.TV_RECOVERY_LAYOUT?.trim() || "AI VP盯盤＋訊號版面";
const REQUIRED_STUDY_KEYS = [
  "AI_WEEKLY_BIAS",
  "AI_DAILY_BIAS",
  "AI_CUR_POC",
  "AI_CUR_VAH",
  "AI_CUR_VAL",
  "AI_PD_POC",
  "AI_PD_VAH",
  "AI_PD_VAL",
  "AI_2D_POC",
  "AI_2D_VAH",
  "AI_2D_VAL",
  "AI_PW_POC",
  "AI_PW_VAH",
  "AI_PW_VAL",
  "AI_2W_POC",
  "AI_2W_VAH",
  "AI_2W_VAL",
];

function brisbaneDateString(date = new Date()) {
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

function previousBrisbaneDateString(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(date));
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  const day = Number(parts.find((p) => p.type === "day")?.value);
  const utc = new Date(Date.UTC(year, month - 1, day));
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

function hasRequiredStudyKeys(studyMap) {
  return REQUIRED_STUDY_KEYS.every((key) => {
    const value = studyMap?.[key];
    return value !== undefined && value !== null && value !== "";
  });
}

async function waitForStableStudyValues(timeoutMs = 15000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    let indicators;
    try {
      indicators = await data.getStudyValues();
    } catch (_) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    const map = getStudyValuesMap(indicators);
    if (!hasRequiredStudyKeys(map)) {
      stableCount = 0;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    const signature = REQUIRED_STUDY_KEYS.map((key) => `${key}:${map[key]}`).join("|");
    if (signature === lastSignature) stableCount += 1;
    else stableCount = 1;
    lastSignature = signature;

    if (stableCount >= 2) {
      return indicators;
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  throw new Error("Study values did not stabilize in time.");
}

async function waitForStableAiVpSnapshot(timeoutMs = 15000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    let pineLabels;
    try {
      pineLabels = await data.getPineLabels({
        study_filter: "AI VP Reader - Full Bias Levels",
        max_labels: 5,
      });
    } catch (_) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    const snapshot = extractAiVpSnapshotFromPineLabels(pineLabels);
    if (!snapshot) {
      stableCount = 0;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    const signature = Object.entries(snapshot.values || {})
      .map(([key, value]) => `${key}:${value}`)
      .join("|");

    if (signature === lastSignature) stableCount += 1;
    else stableCount = 1;

    lastSignature = signature;
    if (stableCount >= 2) return snapshot;

    await new Promise((r) => setTimeout(r, 400));
  }

  throw new Error("AI VP label snapshot did not stabilize in time.");
}

async function waitForExactChartState(expectedSymbol, expectedTimeframe, timeoutMs = 20000) {
  const start = Date.now();
  let stableCount = 0;
  let lastKey = "";
  const expectedTicker = String(expectedSymbol || "").split(":").pop().toUpperCase();

  while (Date.now() - start < timeoutMs) {
    let state;
    try {
      state = await chart.getState();
    } catch (_) {
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }

    const symbol = String(state?.symbol || "");
    const resolution = String(state?.resolution || "");
    const currentTicker = symbol.split(":").pop().toUpperCase();
    const symbolOk =
      symbol.toUpperCase().includes(String(expectedSymbol).toUpperCase()) ||
      currentTicker === expectedTicker ||
      symbol.toUpperCase().endsWith(`:${expectedTicker}`);
    const tfOk = !expectedTimeframe || resolution === String(expectedTimeframe) || resolution === `1${expectedTimeframe}`;
    const key = `${symbol}|${resolution}`;

    if (symbolOk && tfOk) {
      if (key === lastKey) stableCount += 1;
      else stableCount = 1;
      lastKey = key;
      if (stableCount >= 2) return true;
    } else {
      stableCount = 0;
      lastKey = key;
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return false;
}

async function assertAiVpWorkspace() {
  if (!REQUIRED_STUDIES.length) return;

  const isTransientConnectionError = (err) =>
    /CDP connection failed|fetch failed|No TradingView chart target found|No TradingView chart target/i.test(
      String(err?.message || err),
    );

  const checkState = async () => {
    const state = await chart.getState();
    const studyNames = (state?.studies || [])
      .map((s) => String(s?.name || "").trim())
      .filter(Boolean);
    const missing = REQUIRED_STUDIES.filter((required) =>
      !studyNames.some((name) => name.toLowerCase().includes(required.toLowerCase())),
    );
    return { state, studyNames, missing };
  };

  let lastError = null;
  for (let outerAttempt = 0; outerAttempt < 3; outerAttempt += 1) {
    try {
      let current = await checkState();
      if (!current.missing.length) return;

      if (RECOVERY_LAYOUT) {
        let recoveryError = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await ui.layoutSwitch({ name: RECOVERY_LAYOUT });
            await new Promise((r) => setTimeout(r, 1000));
            current = await checkState();
            if (!current.missing.length) return;
          } catch (err) {
            recoveryError = err;
            if (!isTransientConnectionError(err)) break;
          }
        }

        const suffix = recoveryError ? `; last recovery error: ${recoveryError.message}` : "";
        throw new Error(
          `Active chart is not the AI VP workspace. Missing studies: ${current.missing.join(", ")}; recovery layout: ${RECOVERY_LAYOUT}; retried 3 times${suffix}`,
        );
      }

      throw new Error(
        `Active chart is not the AI VP workspace. Missing studies: ${current.missing.join(", ")}${RECOVERY_LAYOUT ? `; recovery layout: ${RECOVERY_LAYOUT}` : ""}`,
      );
    } catch (err) {
      lastError = err;
      if (!isTransientConnectionError(err) || outerAttempt === 2) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  throw lastError || new Error("Unknown AI VP workspace check failure");
}

function assertSafeRulesPath(p) {
  const resolved = resolve(p);
  const inProject =
    resolved === resolve(join(PROJECT_ROOT, "rules.json")) ||
    resolved.startsWith(resolve(PROJECT_ROOT) + "/");
  const inUserData = resolved.startsWith(USER_DATA_DIR + "/");
  if (!inProject && !inUserData) {
    throw new Error(
      `rules_path must live inside the project (${PROJECT_ROOT}) or ~/.tradingview-mcp/. Got: ${resolved}`,
    );
  }
}

function assertSafeDate(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(
      `Invalid date: ${dateStr}. Use YYYY-MM-DD (e.g. 2026-05-11).`,
    );
  }
}

function loadRules(rulesPath) {
  if (rulesPath) assertSafeRulesPath(rulesPath);

  const candidates = [
    rulesPath,
    join(PROJECT_ROOT, "rules.json"),
    join(homedir(), ".tradingview-mcp", "rules.json"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        return { rules: JSON.parse(readFileSync(p, "utf8")), path: p };
      } catch (e) {
        throw new Error(`Failed to parse rules.json at ${p}: ${e.message}`);
      }
    }
  }

  throw new Error(
    "No rules.json found. Copy rules.example.json to rules.json and fill in your trading rules.\n" +
      "Looked in:\n" +
      candidates
        .filter(Boolean)
        .map((p) => `  - ${p}`)
        .join("\n"),
  );
}

export async function runBrief({ rules_path } = {}) {
  return withTradingViewLock(async () => {
    const { rules, path: loadedFrom } = loadRules(rules_path);
    const { watchlist = [], default_timeframe = "240" } = rules;

    if (!watchlist.length) {
      throw new Error(
        "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
      );
    }

    await assertAiVpWorkspace();

    // Save current chart state so we can restore after scanning
    let originalSymbol, originalTimeframe;
    try {
      const currentState = await chart.getState();
      originalSymbol = currentState.symbol;
      originalTimeframe = currentState.resolution;
    } catch (_) {}

    const results = [];

    for (const symbol of watchlist) {
      try {
        await assertAiVpWorkspace();
        await chart.setSymbol({ symbol });
        await chart.setTimeframe({ timeframe: default_timeframe });
        const ready = await waitForExactChartState(symbol, default_timeframe, 25000);
        if (!ready) {
          throw new Error(`Chart did not settle on ${symbol} @ ${default_timeframe}`);
        }

        const stableIndicators = await waitForStableStudyValues(15000);
        const stableAiVp = await waitForStableAiVpSnapshot(15000);

        const [state, quote, ohlcv] = await Promise.all([
          chart.getState(),
          data.getQuote({}),
          data.getOhlcv({ count: 500 }),
        ]);

        const normalizedSymbol = state?.symbol || symbol;
        const normalizedTicker = String(normalizedSymbol).split(":").pop().toUpperCase();
        const expectedTicker = String(symbol).split(":").pop().toUpperCase();
        if (
          normalizedSymbol &&
          !(String(normalizedSymbol).toUpperCase().includes(String(symbol).toUpperCase()) ||
            normalizedTicker === expectedTicker ||
            String(normalizedSymbol).toUpperCase().endsWith(`:${expectedTicker}`))
        ) {
          throw new Error(`Chart symbol mismatch after load: expected ${symbol}, got ${normalizedSymbol}`);
        }

        results.push({
          symbol,
          timeframe: default_timeframe,
          state,
          indicators: stableIndicators,
          ai_vp: stableAiVp,
          quote,
          ohlcv,
        });
      } catch (err) {
        results.push({ symbol, error: err.message });
      }
    }

    // Restore original chart state
    if (originalSymbol) {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        if (originalTimeframe)
          await chart.setTimeframe({ timeframe: originalTimeframe });
      } catch (_) {}
    }

    return {
      success: true,
      generated_at: new Date().toISOString(),
      rules_loaded_from: loadedFrom,
      rules: {
        bias_criteria: rules.bias_criteria || null,
        risk_rules: rules.risk_rules || null,
        notes: rules.notes || null,
      },
      symbols_scanned: results,
      instruction: [
        "For each symbol in symbols_scanned, apply the bias_criteria from rules to the indicator readings.",
        "Output one line per symbol: SYMBOL | BIAS: [bullish/bearish/neutral] | KEY LEVEL: [price] | WATCH: [what to monitor]",
        "End with a one-sentence overall market read.",
        "Be direct. No preamble.",
      ].join(" "),
    };
  }, { name: "morning-brief", waitMs: 10 * 60 * 1000 });
}

export function saveSession({ brief, snapshot, date } = {}) {
  const dateStr = date || brisbaneDateString(new Date());
  assertSafeDate(dateStr);
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
    snapshot: snapshot ?? existing.snapshot ?? null,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || brisbaneDateString(new Date());
  assertSafeDate(dateStr);
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  // Fall back to yesterday
  const yesterdayStr = previousBrisbaneDateString(new Date());
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
