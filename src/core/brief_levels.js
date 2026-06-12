import { getStudyValuesMap } from "./study_values.js";
export { getStudyValuesMap } from "./study_values.js";

function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

const BRISBANE_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Brisbane",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const BRISBANE_HOUR_FMT = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane",
  hour: "2-digit",
  hour12: false,
});

export function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const normalized = String(v)
    .replace(/,/g, "")
    .replace(/[−–—]/g, "-")
    .trim();
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export function formatPrice(v) {
  const n = toNum(v);
  if (n === null) return "n/a";
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 100 ? 2 : abs >= 10 ? 2 : abs >= 1 ? 4 : 6;
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

export function biasWord(n) {
  const num = toNum(n);
  if (num === 1) return "多頭";
  if (num === -1) return "空頭";
  if (/bull/i.test(textOf(n))) return "多頭";
  if (/bear/i.test(textOf(n))) return "空頭";
  return "中性";
}

export function pickValue(indicators, keys) {
  const map = getStudyValuesMap(indicators);
  for (const key of keys) {
    const v = map?.[key];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

export function detectLevels(indicators) {
  return {
    cur: {
      poc: pickValue(indicators, ["AI_CUR_POC"]),
      vah: pickValue(indicators, ["AI_CUR_VAH"]),
      val: pickValue(indicators, ["AI_CUR_VAL"]),
    },
    pd: {
      poc: pickValue(indicators, ["AI_PD_POC"]),
      vah: pickValue(indicators, ["AI_PD_VAH"]),
      val: pickValue(indicators, ["AI_PD_VAL"]),
    },
    d2: {
      poc: pickValue(indicators, ["AI_2D_POC"]),
      vah: pickValue(indicators, ["AI_2D_VAH"]),
      val: pickValue(indicators, ["AI_2D_VAL"]),
    },
    pw: {
      poc: pickValue(indicators, ["AI_PW_POC"]),
      vah: pickValue(indicators, ["AI_PW_VAH"]),
      val: pickValue(indicators, ["AI_PW_VAL"]),
    },
    w2: {
      poc: pickValue(indicators, ["AI_2W_POC"]),
      vah: pickValue(indicators, ["AI_2W_VAH"]),
      val: pickValue(indicators, ["AI_2W_VAL"]),
    },
  };
}

export function sideForBias(dailyBias, weeklyBias) {
  const daily = biasWord(dailyBias);
  const weekly = biasWord(weeklyBias);
  const aligned = daily === weekly && daily !== "中性";
  return { daily, weekly, aligned };
}

export function touchedAndReclaimed(bar, level, mode) {
  const n = toNum(level);
  if (!bar || n === null) return false;
  if (mode === "val") return toNum(bar.low) <= n && toNum(bar.close) > n;
  if (mode === "vah") return toNum(bar.high) >= n && toNum(bar.close) < n;
  return false;
}

function barTimeKey(time) {
  const n = toNum(time);
  if (n === null) return null;
  const ms = n < 1e12 ? n * 1000 : n;
  if (!Number.isFinite(ms)) return null;
  return BRISBANE_DATE_FMT.format(new Date(ms));
}

export function brisbaneHour(date = new Date()) {
  const parts = BRISBANE_HOUR_FMT.formatToParts(new Date(date));
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  return Number.isFinite(hour) ? hour : null;
}

export function isAfterBrisbaneHour(hourThreshold = 17, date = new Date()) {
  const hour = brisbaneHour(date);
  return hour === null ? false : hour >= hourThreshold;
}

export function getYesterdaySessionBars(bars) {
  const grouped = new Map();
  for (const bar of Array.isArray(bars) ? bars : []) {
    const key = barTimeKey(bar?.time);
    if (!key) continue;
    const list = grouped.get(key) || [];
    list.push(bar);
    grouped.set(key, list);
  }

  const keys = [...grouped.keys()].sort();
  if (!keys.length) {
    return { sessionKey: null, bars: [], sessionKeys: [] };
  }

  const sessionKey = keys.length >= 2 ? keys[keys.length - 2] : keys[keys.length - 1];
  return {
    sessionKey,
    bars: grouped.get(sessionKey) || [],
    sessionKeys: keys,
  };
}

export function summarizeYesterdayFakeouts(bars, levels, dailyBias, weeklyBias) {
  const { daily } = sideForBias(dailyBias, weeklyBias);
  const longBias = daily === "多頭";
  const shortBias = daily === "空頭";
  const session = getYesterdaySessionBars(bars);

  const candidates = [];
  if (longBias) {
    for (const [label, level] of [["CUR", levels.cur.val], ["PD", levels.pd.val], ["2D", levels.d2.val], ["PW", levels.pw.val], ["2W", levels.w2.val]]) {
      if (session.bars.some((bar) => touchedAndReclaimed(bar, level, "val"))) candidates.push(`${label} VAL`);
    }
  } else if (shortBias) {
    for (const [label, level] of [["CUR", levels.cur.vah], ["PD", levels.pd.vah], ["2D", levels.d2.vah], ["PW", levels.pw.vah], ["2W", levels.w2.vah]]) {
      if (session.bars.some((bar) => touchedAndReclaimed(bar, level, "vah"))) candidates.push(`${label} VAH`);
    }
  }

  const unique = [...new Set(candidates)];
  if (unique.length > 0) {
    return `昨日已 fakeout：${unique.join(" / ")}`;
  }
  return "昨日未見明確 fakeout";
}

export function summarizeYesterdayFakeoutsFromEvents(events) {
  const labels = [...new Set((Array.isArray(events) ? events : [])
    .map((event) => String(event?.label || "").trim())
    .filter(Boolean))];
  if (labels.length > 0) {
    return `昨日已 fakeout：${labels.join(" / ")}`;
  }
  return "昨日未見明確 fakeout";
}

export function getTodayReminder(levels, weeklyBias, dailyBias) {
  const daily = biasWord(dailyBias);
  const weekly = biasWord(weeklyBias);

  if (weekly === "多頭" && daily === "多頭") {
    return `今日提醒：日內短多盯 current VAL；周極點多盯 PD/2D/PW/2W VAL`;
  }
  if (weekly === "空頭" && daily === "空頭") {
    return `今日提醒：日內短空盯 current VAH；周極點空盯 PD/2D/PW/2W VAH`;
  }
  if (weekly === "多頭" && daily === "空頭") {
    return `今日提醒：日內短空盯 current VAH；周極點多盯 PD/2D/PW/2W VAL`;
  }
  if (weekly === "空頭" && daily === "多頭") {
    return `今日提醒：日內短多盯 current VAL；周極點空盯 PD/2D/PW/2W VAH`;
  }
  return `今日提醒：先觀察 current VAH / VAL；等待週日偏見明確後再決定方向`;
}

export function summarizeFakeouts(symbol, quote, bars, levels, dailyBias, weeklyBias) {
  const { daily, weekly, aligned } = sideForBias(dailyBias, weeklyBias);
  const q = quote || {};
  const lastPrice = toNum(q.last) ?? toNum(q.close);
  const priceLine = lastPrice === null ? "" : `現價 ${formatPrice(lastPrice)}，`;
  return `${symbol}\n週偏見${weekly} / 日偏見${daily}${aligned ? "，方向一致" : "，方向不一致"}\n${priceLine}${summarizeYesterdayFakeouts(bars, levels, dailyBias, weeklyBias)}`;
}

export function getAlertPlan(levels, weeklyBias, dailyBias) {
  const daily = biasWord(dailyBias);
  const weekly = biasWord(weeklyBias);

  const trendLong = () => ([
    { label: "PD VAL", level: levels.pd.val, opportunity: "多單機會", mode: "val" },
    { label: "2D VAL", level: levels.d2.val, opportunity: "多單機會", mode: "val" },
    { label: "PW VAL", level: levels.pw.val, opportunity: "多單機會", mode: "val" },
    { label: "2W VAL", level: levels.w2.val, opportunity: "多單機會", mode: "val" },
  ]);

  const trendShort = () => ([
    { label: "PD VAH", level: levels.pd.vah, opportunity: "空單機會", mode: "vah" },
    { label: "2D VAH", level: levels.d2.vah, opportunity: "空單機會", mode: "vah" },
    { label: "PW VAH", level: levels.pw.vah, opportunity: "空單機會", mode: "vah" },
    { label: "2W VAH", level: levels.w2.vah, opportunity: "空單機會", mode: "vah" },
  ]);

  const counterWeekShort = () => ([
    { label: "今日 VAH", level: levels.cur.vah, opportunity: "短空機會", mode: "vah" },
  ]);

  const counterWeekLong = () => ([
    { label: "今日 VAL", level: levels.cur.val, opportunity: "短多機會", mode: "val" },
  ]);

  const reversalLong = () => ([
    { label: "PD VAL", level: levels.pd.val, opportunity: "大級別反轉多單機會", mode: "val" },
    { label: "2D VAL", level: levels.d2.val, opportunity: "大級別反轉多單機會", mode: "val" },
    { label: "PW VAL", level: levels.pw.val, opportunity: "大級別反轉多單機會", mode: "val" },
    { label: "2W VAL", level: levels.w2.val, opportunity: "大級別反轉多單機會", mode: "val" },
  ]);

  const reversalShort = () => ([
    { label: "PD VAH", level: levels.pd.vah, opportunity: "大級別反轉空單機會", mode: "vah" },
    { label: "2D VAH", level: levels.d2.vah, opportunity: "大級別反轉空單機會", mode: "vah" },
    { label: "PW VAH", level: levels.pw.vah, opportunity: "大級別反轉空單機會", mode: "vah" },
    { label: "2W VAH", level: levels.w2.vah, opportunity: "大級別反轉空單機會", mode: "vah" },
  ]);

  if (weekly === "多頭" && daily === "多頭") return trendLong();
  if (weekly === "空頭" && daily === "空頭") return trendShort();
  if (weekly === "多頭" && daily === "空頭") return [...counterWeekShort(), ...reversalLong()];
  if (weekly === "空頭" && daily === "多頭") return [...counterWeekLong(), ...reversalShort()];
  return [];
}
