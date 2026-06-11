function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

export function getStudyValuesMap(indicators) {
  const map = {};
  const seen = new Set();

  function walk(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith("AI_") || key === "Up" || key === "Down" || key === "Total") {
        map[key] = value;
      }
      if (value && typeof value === "object") walk(value);
    }
  }

  walk(indicators);
  return map;
}

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

export function summarizeFakeouts(symbol, quote, bars, levels, dailyBias, weeklyBias) {
  const latest = bars?.slice?.(-2) || [];
  const prev = latest[latest.length - 1] || null;
  const { daily, weekly, aligned } = sideForBias(dailyBias, weeklyBias);
  const longBias = daily === "多頭";
  const shortBias = daily === "空頭";

  const candidates = [];
  if (longBias) {
    for (const [label, level] of [["PD", levels.pd.val], ["2D", levels.d2.val], ["PW", levels.pw.val], ["2W", levels.w2.val]]) {
      if (touchedAndReclaimed(prev, level, "val")) candidates.push(`${label} VAL`);
    }
  } else if (shortBias) {
    for (const [label, level] of [["PD", levels.pd.vah], ["2D", levels.d2.vah], ["PW", levels.pw.vah], ["2W", levels.w2.vah]]) {
      if (touchedAndReclaimed(prev, level, "vah")) candidates.push(`${label} VAH`);
    }
  }

  const lines = [];
  if (candidates.length > 0) {
    const side = longBias ? "多單" : "空單";
    lines.push(`昨日已出現 ${candidates.join(" / ")} fakeout，請人工盯盤尋找${side}機會。`);
  } else {
    lines.push("昨日未見明確 fakeout 或未回收 value area，暫時不追單。");
  }

  const q = quote || {};
  const lastPrice = toNum(q.last) ?? toNum(q.close);
  const priceLine = lastPrice === null ? "" : `現價 ${formatPrice(lastPrice)}，`;

  return `${symbol}\n週偏見${weekly} / 日偏見${daily}${aligned ? "，方向一致" : "，方向不一致"}\n${priceLine}${lines.join(" ")}`;
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
