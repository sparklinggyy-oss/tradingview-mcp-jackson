import { getStudyValuesMap } from "./study_values.js";
export { getStudyValuesMap } from "./study_values.js";

function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
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

export function biasWord(n) {
  const num = toNum(n);
  if (num === 1) return "多頭";
  if (num === -1) return "空頭";
  if (/bull/i.test(textOf(n))) return "多頭";
  if (/bear/i.test(textOf(n))) return "空頭";
  return "中性";
}

export function extractVpLevels(indicators) {
  const map = getStudyValuesMap(indicators);
  const pick = (...keys) => {
    for (const key of keys) {
      const v = map?.[key];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  };
  return {
    cur: { poc: pick("AI_CUR_POC"), vah: pick("AI_CUR_VAH"), val: pick("AI_CUR_VAL") },
    pd: { poc: pick("AI_PD_POC"), vah: pick("AI_PD_VAH"), val: pick("AI_PD_VAL") },
    d2: { poc: pick("AI_2D_POC"), vah: pick("AI_2D_VAH"), val: pick("AI_2D_VAL") },
    pw: { poc: pick("AI_PW_POC"), vah: pick("AI_PW_VAH"), val: pick("AI_PW_VAL") },
    w2: { poc: pick("AI_2W_POC"), vah: pick("AI_2W_VAH"), val: pick("AI_2W_VAL") },
    bias: {
      daily: biasWord(map.AI_DAILY_BIAS),
      weekly: biasWord(map.AI_WEEKLY_BIAS),
      dailyRaw: map.AI_DAILY_BIAS ?? null,
      weeklyRaw: map.AI_WEEKLY_BIAS ?? null,
    },
  };
}

export function isAlignedBias(levels) {
  return levels?.bias?.daily === levels?.bias?.weekly && levels?.bias?.daily !== "中性";
}

export function formatPrice(v) {
  const n = toNum(v);
  if (n === null) return "n/a";
  const abs = Math.abs(n);
  const decimals = abs >= 1000 ? 2 : abs >= 100 ? 2 : abs >= 10 ? 2 : abs >= 1 ? 4 : 6;
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}
