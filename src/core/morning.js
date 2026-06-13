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
import { buildAiVpSnapshotFromStudyValues, getStudyValuesMap } from "./study_values.js";
import { withTradingViewLock } from "./tradingview_lock.js";
import * as replay from "./replay.js";
import * as tab from "./tab.js";
import * as pane from "./pane.js";
import { connectToTarget, disconnect, getTargetInfo } from "../connection.js";
import * as ui from "./ui.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../../");
const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");
const USER_DATA_DIR = resolve(join(homedir(), ".tradingview-mcp"));
const REQUIRED_STUDIES = String(
  process.env.TV_REQUIRED_STUDIES ||
    "AI VP Reader - Full Bias Levels 10.1,Session Volume Profile,Absorption Bubbles",
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
const DEFAULT_AI_VP_OVERRIDE_FILE = resolve(PROJECT_ROOT, "snapshots", "live_ai_vp_override.json");
const DEFAULT_MORNING_SYMBOL_SWITCH_DELAY_MS = Number(
  process.env.TV_MORNING_SYMBOL_SWITCH_DELAY_MS || 20000,
);

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

function normalizeAiVpSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.levels && raw.values) return raw;

  const levels = raw.levels || raw.level || null;
  const values = raw.values || raw.value || null;
  if (!levels || !values) return null;

  return {
    ...raw,
    source: raw.source || "override",
    levels,
    values,
  };
}

function loadAiVpOverrideMap() {
  const filePath = process.env.TV_AI_VP_OVERRIDE_FILE?.trim() || DEFAULT_AI_VP_OVERRIDE_FILE;
  if (!filePath || !existsSync(filePath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;

    const map = {};
    for (const [symbol, value] of Object.entries(parsed)) {
      const snapshot = normalizeAiVpSnapshot(value);
      if (symbol && snapshot) map[symbol] = snapshot;
    }
    return Object.keys(map).length ? map : null;
  } catch {
    return null;
  }
}

function aiVpSnapshotSignature(snapshot) {
  if (!snapshot?.values) return "";
  return [
    snapshot.dailyBiasRaw ?? "",
    snapshot.weeklyBiasRaw ?? "",
    snapshot.values.AI_CUR_POC ?? "",
    snapshot.values.AI_CUR_VAH ?? "",
    snapshot.values.AI_CUR_VAL ?? "",
    snapshot.values.AI_PD_POC ?? "",
    snapshot.values.AI_PD_VAH ?? "",
    snapshot.values.AI_PD_VAL ?? "",
    snapshot.values.AI_2D_POC ?? "",
    snapshot.values.AI_2D_VAH ?? "",
    snapshot.values.AI_2D_VAL ?? "",
    snapshot.values.AI_PW_POC ?? "",
    snapshot.values.AI_PW_VAH ?? "",
    snapshot.values.AI_PW_VAL ?? "",
    snapshot.values.AI_2W_POC ?? "",
    snapshot.values.AI_2W_VAH ?? "",
    snapshot.values.AI_2W_VAL ?? "",
  ].join("|");
}

function matchesExpectedSymbol(actualSymbol, expectedSymbol) {
  const actual = String(actualSymbol || "");
  const expected = String(expectedSymbol || "");
  if (!actual || !expected) return false;

  const actualTicker = actual.split(":").pop().toUpperCase();
  const expectedTicker = expected.split(":").pop().toUpperCase();
  return (
    actual.toUpperCase().includes(expected.toUpperCase()) ||
    actualTicker === expectedTicker ||
    actual.toUpperCase().endsWith(`:${expectedTicker}`)
  );
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

    if (stableCount >= 3) {
      return indicators;
    }

    await new Promise((r) => setTimeout(r, 800));
  }

  throw new Error("Study values did not stabilize in time.");
}

async function readAiVpStudySnapshot() {
  try {
    return buildAiVpSnapshotFromStudyValues(await data.getStudyValues());
  } catch (_) {
    return null;
  }
}

async function waitForFreshAiVpSnapshot(expectedSymbol, previousSignature = "", timeoutMs = 20000, paneIndex = 0) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    let state = null;
    try {
      state = await pane.getState({ index: paneIndex });
    } catch (_) {
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    if (!matchesExpectedSymbol(state?.symbol, expectedSymbol)) {
      stableCount = 0;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    const snapshot = await readAiVpStudySnapshot();
    const signature = aiVpSnapshotSignature(snapshot);
    if (!snapshot || !signature) {
      stableCount = 0;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    if (previousSignature && signature === previousSignature) {
      stableCount = 0;
      lastSignature = signature;
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    if (signature === lastSignature) stableCount += 1;
    else stableCount = 1;
    lastSignature = signature;

    if (stableCount >= 2) return snapshot;

    await new Promise((r) => setTimeout(r, 350));
  }

  return null;
}

async function readAiVpStudySnapshotById(entityId) {
  if (!entityId) return null;
  try {
    const result = await data.getStudyValuesById({ entity_id: entityId });
    return buildAiVpSnapshotFromStudyValues({ studies: [result.study] });
  } catch (_) {
    return null;
  }
}

async function waitForFreshAiVpSnapshotById(entityId, previousSignature = "", timeoutMs = 20000) {
  const start = Date.now();
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    const snapshot = await readAiVpStudySnapshotById(entityId);
    const signature = aiVpSnapshotSignature(snapshot);
    if (!snapshot || !signature) {
      stableCount = 0;
      lastSignature = null;
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    if (previousSignature && signature === previousSignature) {
      stableCount = 0;
      lastSignature = signature;
      await new Promise((r) => setTimeout(r, 350));
      continue;
    }

    if (signature === lastSignature) stableCount += 1;
    else stableCount = 1;
    lastSignature = signature;

    if (stableCount >= 2) return snapshot;

    await new Promise((r) => setTimeout(r, 350));
  }

  return null;
}

async function waitForExactChartState(expectedSymbol, expectedTimeframe, timeoutMs = 20000, paneIndex = 0) {
  const start = Date.now();
  let stableCount = 0;
  let lastKey = "";
  const expectedTicker = String(expectedSymbol || "").split(":").pop().toUpperCase();

  while (Date.now() - start < timeoutMs) {
    let state;
    try {
      state = await pane.getState({ index: paneIndex });
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
      if (stableCount >= 4) return true;
    } else {
      stableCount = 0;
      lastKey = key;
    }

    await new Promise((r) => setTimeout(r, 500));
  }

  return false;
}

function findPrimaryAiVpStudy(studies) {
  const normalized = Array.isArray(studies) ? studies : [];
  const exactMatches = normalized.filter((study) =>
    String(study?.name || "").toLowerCase().includes("ai vp reader - full bias levels"),
  );
  if (exactMatches.length > 0) return exactMatches[exactMatches.length - 1];
  return normalized[normalized.length - 1] || null;
}

async function waitForPrimaryAiVpStudyReady(expectedSymbol, timeoutMs = 40000, paneIndex = 0) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    let state;
    try {
      state = await pane.getState({ index: paneIndex });
    } catch (_) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    if (!matchesExpectedSymbol(state?.symbol, expectedSymbol)) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    try {
      const chartState = await chart.getState();
      const aiStudy = findPrimaryAiVpStudy(chartState?.studies || []);
      if (aiStudy?.id && matchesExpectedSymbol(state?.symbol, expectedSymbol)) {
        return aiStudy.id;
      }
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 500));
  }

  return null;
}

async function waitForPrimaryAiVpSnapshot(expectedSymbol, timeoutMs = 60000, paneIndex = 0) {
  const start = Date.now();
  let lastStudyId = null;
  let lastSignature = null;
  let stableCount = 0;

  while (Date.now() - start < timeoutMs) {
    let state = null;
    try {
      state = await pane.getState({ index: paneIndex });
    } catch (_) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    if (!matchesExpectedSymbol(state?.symbol, expectedSymbol)) {
      lastStudyId = null;
      lastSignature = null;
      stableCount = 0;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    let chartState = null;
    try {
      chartState = await chart.getState();
    } catch (_) {
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    const aiStudy = findPrimaryAiVpStudy(chartState?.studies || []);
    if (!aiStudy?.id) {
      lastStudyId = null;
      lastSignature = null;
      stableCount = 0;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    if (lastStudyId !== aiStudy.id) {
      lastStudyId = aiStudy.id;
      lastSignature = null;
      stableCount = 0;
    }

    let snapshot = null;
    try {
      snapshot = await readAiVpStudySnapshotById(aiStudy.id);
    } catch (_) {
      snapshot = null;
    }

    const signature = aiVpSnapshotSignature(snapshot);
    if (!snapshot || !signature) {
      lastSignature = null;
      stableCount = 0;
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }

    if (signature === lastSignature) stableCount += 1;
    else stableCount = 1;
    lastSignature = signature;

    if (stableCount >= 2) return snapshot;

    await new Promise((r) => setTimeout(r, 400));
  }

  return null;
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

async function focusPinnedTradingViewTab() {
  const pinnedTargetId = process.env.TV_MORNING_TARGET_ID?.trim();
  if (!pinnedTargetId) return;

  const tabs = await tab.list();
  const targetIndex = tabs?.tabs?.findIndex((t) => t.id === pinnedTargetId) ?? -1;
  if (targetIndex < 0) {
    throw new Error(
      `Pinned morning target not found: ${pinnedTargetId}. Use tab_list to refresh TV_MORNING_TARGET_ID.`,
    );
  }

  const currentTarget = await getTargetInfo().catch(() => null);
  if (currentTarget?.id !== pinnedTargetId) {
    await tab.switchTab({ index: targetIndex });
    await disconnect().catch(() => {});
    await connectToTarget(pinnedTargetId);
    await new Promise((r) => setTimeout(r, 1000));
  }
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

async function runMorningBriefImpl({
  rules_path,
  symbol_switch_delay_ms,
  snapshot_read_mode = "legacy",
} = {}) {
  return withTradingViewLock(async () => {
    const { rules, path: loadedFrom } = loadRules(rules_path);
    const { watchlist = [], default_timeframe = "240" } = rules;
    const symbolSwitchDelayMs = Number.isFinite(Number(symbol_switch_delay_ms))
      ? Number(symbol_switch_delay_ms)
      : DEFAULT_MORNING_SYMBOL_SWITCH_DELAY_MS;

    if (!watchlist.length) {
      throw new Error(
        "rules.json watchlist is empty. Add at least one symbol to your watchlist array.",
      );
    }

    await focusPinnedTradingViewTab();
    await assertAiVpWorkspace();
    try {
      const replayState = await replay.status();
      if (replayState?.is_replay_started) {
        await replay.stop();
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (_) {}

    let originalLayout = null;
    try {
      const layoutState = await pane.list();
      originalLayout = layoutState?.layout || null;
    } catch (_) {}

    try {
      await pane.setLayout({ layout: "s" });
      await new Promise((r) => setTimeout(r, 1000));
      await pane.focus({ index: 0 });
    } catch (_) {}

    try {
      await pane.focus({ index: 0 });
    } catch (_) {}

    if (default_timeframe) {
      try {
        await chart.setTimeframe({ timeframe: default_timeframe });
        await waitForExactChartState(null, default_timeframe, 15000, 0);
      } catch (_) {}
    }

    // Save current chart state so we can restore after scanning
    let originalSymbol, originalTimeframe;
    try {
      const currentState = await chart.getState();
      originalSymbol = currentState.symbol;
      originalTimeframe = currentState.resolution;
    } catch (_) {}

    const results = [];
    let lastAiVpSignature = "";
    const maxSymbolAttempts = Math.max((Number(watchlist.length) || 0) * 2, 1);

    for (let idx = 0; idx < watchlist.length; idx += 1) {
      const symbol = watchlist[idx];
      try {
        await assertAiVpWorkspace();
        let ready = false;
        let normalizedSymbol = null;
        let settledState = null;
        let symbolMatched = false;
        let lastLoadedSymbol = null;

        for (let attempt = 0; attempt < maxSymbolAttempts; attempt += 1) {
          try {
            await pane.focus({ index: 0 });
            await pane.setSymbol({ index: 0, symbol });
            await pane.focus({ index: 0 });
          } catch (_) {
            await chart.setSymbol({ symbol });
          }
          ready = await waitForExactChartState(symbol, default_timeframe, 40000, 0);
          if (!ready) {
            console.warn(`Chart did not fully settle on ${symbol} @ ${default_timeframe}; continuing with live snapshot read`);
          }

          try {
            await chart.goToRealtime();
          } catch (_) {}
          try {
            await ui.keyboard({ key: "End" });
          } catch (_) {}

          await new Promise((r) => setTimeout(r, 5000));
          const currentState = await pane.getState({ index: 0 }).catch(() => null);
          settledState = currentState;
          normalizedSymbol = currentState?.symbol || symbol;
          lastLoadedSymbol = normalizedSymbol;
          const normalizedTicker = String(normalizedSymbol).split(":").pop().toUpperCase();
          const expectedTicker = String(symbol).split(":").pop().toUpperCase();
          const symbolMatches =
            normalizedSymbol &&
            (String(normalizedSymbol).toUpperCase().includes(String(symbol).toUpperCase()) ||
              normalizedTicker === expectedTicker ||
              String(normalizedSymbol).toUpperCase().endsWith(`:${expectedTicker}`));

          if (symbolMatches) {
            symbolMatched = true;
            break;
          }

          if (attempt < maxSymbolAttempts - 1) {
            console.warn(
              `Chart symbol mismatch after load on ${symbol} (attempt ${attempt + 1}/${maxSymbolAttempts}): expected ${symbol}, got ${normalizedSymbol}; retrying`,
            );
            continue;
          }
        }

        if (!symbolMatched) {
          throw new Error(
            `Chart symbol mismatch after load: expected ${symbol}, got ${lastLoadedSymbol || normalizedSymbol || "unknown"}`,
          );
        }

        let stableAiVp = null;
        if (snapshot_read_mode === "strict") {
          stableAiVp = await waitForPrimaryAiVpSnapshot(symbol, 60000, 0);
        } else {
          try {
            const aiStudyId = await waitForPrimaryAiVpStudyReady(symbol, 40000, 0);
            if (aiStudyId) {
              stableAiVp = await waitForFreshAiVpSnapshotById(aiStudyId, lastAiVpSignature, 40000);
            }
          } catch (_) {}

          if (!stableAiVp) {
            stableAiVp = await waitForFreshAiVpSnapshot(symbol, lastAiVpSignature, 40000, 0);
          }
        }

        if (!stableAiVp) {
          throw new Error(`AI VP snapshot unavailable for ${symbol} after live study read`);
        }
        lastAiVpSignature = aiVpSnapshotSignature(stableAiVp);

        if (process.env.DEBUG_AI_VP === "1" && String(symbol).includes("BTCUSDT")) {
          try {
            const rawStudies = await data.getStudyValues();
            const aiStudies = (rawStudies?.studies || [])
              .filter((s) =>
                String(s?.name || "")
                  .toLowerCase()
                  .includes("ai vp reader - full bias levels"),
              )
              .map((s) => {
                const snap = buildAiVpSnapshotFromStudyValues({ studies: [s] });
                return {
                  id: s.id || null,
                  name: s.name || null,
                  daily: snap?.dailyBiasRaw ?? null,
                  weekly: snap?.weeklyBiasRaw ?? null,
                  cur: snap?.levels?.cur || null,
                  pd: snap?.levels?.pd || null,
                  d2: snap?.levels?.d2 || null,
                  pw: snap?.levels?.pw || null,
                  w2: snap?.levels?.w2 || null,
                };
              });
            console.log(`[DEBUG_AI_VP] ${symbol} raw_ai_studies: ${JSON.stringify(aiStudies)}`);
          } catch (e) {
            console.log(`[DEBUG_AI_VP] ${symbol} raw_ai_studies error: ${e.message}`);
          }
        }

        const [state, quote, ohlcv] = await Promise.all([
          Promise.resolve(settledState || pane.getState({ index: 0 })),
          data.getQuote({}),
          data.getOhlcv({ count: 500 }),
        ]);

        const loadedSymbol = state?.symbol || symbol;
        const normalizedTicker = String(loadedSymbol).split(":").pop().toUpperCase();
        const expectedTicker = String(symbol).split(":").pop().toUpperCase();
        if (
          loadedSymbol &&
          !(String(loadedSymbol).toUpperCase().includes(String(symbol).toUpperCase()) ||
            normalizedTicker === expectedTicker ||
            String(loadedSymbol).toUpperCase().endsWith(`:${expectedTicker}`))
        ) {
          throw new Error(`Chart symbol mismatch after load: expected ${symbol}, got ${loadedSymbol}`);
        }

        results.push({
          symbol,
          timeframe: default_timeframe,
          state,
          indicators: stableAiVp,
          ai_vp: stableAiVp,
          quote,
          ohlcv,
        });
      } catch (err) {
        results.push({ symbol, error: err.message });
      }

      const isLastSymbol = idx === watchlist.length - 1;
      if (!isLastSymbol && symbolSwitchDelayMs > 0) {
        await new Promise((r) => setTimeout(r, symbolSwitchDelayMs));
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
    if (originalLayout) {
      try {
        await pane.setLayout({ layout: originalLayout });
        await new Promise((r) => setTimeout(r, 1000));
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

export async function runBrief({ rules_path, symbol_switch_delay_ms } = {}) {
  return runMorningBriefImpl({ rules_path, symbol_switch_delay_ms, snapshot_read_mode: "legacy" });
}

export async function runStrictBrief({ rules_path, symbol_switch_delay_ms } = {}) {
  return runMorningBriefImpl({ rules_path, symbol_switch_delay_ms, snapshot_read_mode: "strict" });
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
