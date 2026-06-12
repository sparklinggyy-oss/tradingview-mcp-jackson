function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

function hasAiKeys(values) {
  if (!values || typeof values !== "object") return false;
  return Object.keys(values).some((key) => key.startsWith("AI_"));
}

function normalizeText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function normalizeStudies(indicators) {
  if (Array.isArray(indicators)) return indicators;
  if (Array.isArray(indicators?.studies)) return indicators.studies;
  return [];
}

function normalizeStudy(study) {
  if (!study || typeof study !== "object") return null;
  const name = textOf(study.name).trim();
  const values = study.values && typeof study.values === "object" ? study.values : null;
  if (!name && !values) return null;
  return { ...study, name, values };
}

function selectPrimaryStudy(indicators) {
  const studies = normalizeStudies(indicators)
    .map(normalizeStudy)
    .filter(Boolean);

  if (!studies.length) return null;

  const exactMatches = studies.filter((study) =>
    study.name.toLowerCase().includes("ai vp reader - full bias levels"),
  );
  if (exactMatches.length > 0) {
    return exactMatches[exactMatches.length - 1];
  }

  const aiMatches = studies.filter((study) => hasAiKeys(study.values));
  if (aiMatches.length > 0) {
    return aiMatches[aiMatches.length - 1];
  }

  return studies[studies.length - 1] || null;
}

export function getStudyValuesMap(indicators) {
  const study = selectPrimaryStudy(indicators);
  if (!study || !study.values) return {};
  return { ...study.values };
}

export function getPrimaryStudy(indicators) {
  return selectPrimaryStudy(indicators);
}

function parseLabelLine(line) {
  const trimmed = normalizeText(line).trim();
  const biasMatch = trimmed.match(/^(Daily|Weekly):\s*(.+)$/i);
  if (biasMatch) {
    return { type: biasMatch[1].toLowerCase(), value: biasMatch[2].trim() };
  }

  const levelMatch = trimmed.match(/^(CUR|PD|2D|PW|2W):\s*(.+)$/i);
  if (!levelMatch) return null;

  const keyMap = {
    CUR: "cur",
    PD: "pd",
    "2D": "d2",
    PW: "pw",
    "2W": "w2",
  };
  const key = keyMap[levelMatch[1].toUpperCase()];
  if (!key) return null;

  const values = levelMatch[2].split("/").map((s) => s.trim());
  if (values.length !== 3) return null;

  return {
    type: "level",
    key,
    value: {
      poc: values[0],
      vah: values[1],
      val: values[2],
    },
  };
}

export function extractAiVpSnapshotFromPineLabels(pineLabels) {
  const studies = Array.isArray(pineLabels?.studies) ? pineLabels.studies : [];
  if (!studies.length) return null;

  const study =
    studies.find((s) =>
      normalizeText(s?.name).toLowerCase().includes("ai vp reader - full bias levels"),
    ) || studies[studies.length - 1];

  const labels = Array.isArray(study?.labels) ? study.labels : [];
  if (!labels.length) return null;

  const latestLabel =
    [...labels]
      .reverse()
      .find((label) => /(^|\n)\s*CUR:/i.test(normalizeText(label?.text))) ||
    labels[labels.length - 1];

  const text = normalizeText(latestLabel?.text);
  if (!text) return null;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const levels = {
    cur: { poc: null, vah: null, val: null },
    pd: { poc: null, vah: null, val: null },
    d2: { poc: null, vah: null, val: null },
    pw: { poc: null, vah: null, val: null },
    w2: { poc: null, vah: null, val: null },
  };
  let dailyBiasRaw = null;
  let weeklyBiasRaw = null;

  for (const line of lines) {
    const parsed = parseLabelLine(line);
    if (!parsed) continue;
    if (parsed.type === "daily") dailyBiasRaw = parsed.value;
    else if (parsed.type === "weekly") weeklyBiasRaw = parsed.value;
    else if (parsed.type === "level" && parsed.key && parsed.value) levels[parsed.key] = parsed.value;
  }

  const values = {
    AI_CUR_POC: levels.cur.poc,
    AI_CUR_VAH: levels.cur.vah,
    AI_CUR_VAL: levels.cur.val,
    AI_PD_POC: levels.pd.poc,
    AI_PD_VAH: levels.pd.vah,
    AI_PD_VAL: levels.pd.val,
    AI_2D_POC: levels.d2.poc,
    AI_2D_VAH: levels.d2.vah,
    AI_2D_VAL: levels.d2.val,
    AI_PW_POC: levels.pw.poc,
    AI_PW_VAH: levels.pw.vah,
    AI_PW_VAL: levels.pw.val,
    AI_2W_POC: levels.w2.poc,
    AI_2W_VAH: levels.w2.vah,
    AI_2W_VAL: levels.w2.val,
    AI_DAILY_BIAS: dailyBiasRaw,
    AI_WEEKLY_BIAS: weeklyBiasRaw,
  };

  if (Object.values(values).some((v) => v === null || v === undefined || v === "")) {
    return null;
  }

  return {
    source: "pine_label",
    label_text: text,
    dailyBiasRaw,
    weeklyBiasRaw,
    dailyBias: /bull/i.test(dailyBiasRaw) ? "多頭" : /bear/i.test(dailyBiasRaw) ? "空頭" : null,
    weeklyBias: /bull/i.test(weeklyBiasRaw) ? "多頭" : /bear/i.test(weeklyBiasRaw) ? "空頭" : null,
    levels,
    values,
  };
}
