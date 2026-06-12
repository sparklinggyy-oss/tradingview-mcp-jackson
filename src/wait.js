import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastSignature = "";
  let stableCount = 0;
  const expectedTicker = expectedSymbol ? String(expectedSymbol).split(":").pop().toUpperCase() : null;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
        var symbol = '';
        var resolution = '';
        var isLoading = false;
        var barCount = -1;
        try {
          symbol = chart.symbol();
        } catch(e) {}
        try {
          resolution = chart.resolution();
        } catch(e) {}
        try {
          var spinner = document.querySelector('[class*="loader"]')
            || document.querySelector('[class*="loading"]')
            || document.querySelector('[data-name="loading"]');
          isLoading = !!(spinner && spinner.offsetParent !== null);
        } catch(e) {}
        try {
          var bars = chart.model().mainSeries().bars();
          if (bars && typeof bars.size === 'function') barCount = bars.size();
        } catch(e) {}
        return { isLoading: isLoading, barCount: barCount, currentSymbol: symbol, resolution: resolution };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    const currentSymbol = String(state.currentSymbol || "");
    const currentTicker = currentSymbol.split(":").pop().toUpperCase();
    const symbolOk =
      !expectedSymbol ||
      currentSymbol.toUpperCase().includes(String(expectedSymbol).toUpperCase()) ||
      currentTicker === expectedTicker ||
      currentSymbol.toUpperCase().endsWith(`:${expectedTicker}`);
    const tfOk = !expectedTf || String(state.resolution || "") === String(expectedTf) || String(state.resolution || "") === `1${expectedTf}`;

    if (!symbolOk || !tfOk) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check bar count stability
    const signature = `${currentSymbol}|${state.resolution || ""}|${state.barCount}`;
    if (signature === lastSignature && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastSignature = signature;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — return true anyway, caller should verify
  return false;
}
