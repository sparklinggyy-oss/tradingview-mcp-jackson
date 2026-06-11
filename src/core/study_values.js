function textOf(value) {
  return value === null || value === undefined ? "" : String(value);
}

function hasAiKeys(values) {
  if (!values || typeof values !== "object") return false;
  return Object.keys(values).some((key) => key.startsWith("AI_"));
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
