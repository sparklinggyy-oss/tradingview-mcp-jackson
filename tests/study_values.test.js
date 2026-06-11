import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getPrimaryStudy, getStudyValuesMap } from "../src/core/study_values.js";

describe("study_values — primary AI study selection", () => {
  it("prefers AI VP Reader - Full Bias Levels over other studies", () => {
    const indicators = {
      studies: [
        {
          name: "Session Volume Profile",
          values: { AI_PD_VAH: "111", AI_PD_VAL: "222" },
        },
        {
          name: "AI VP Reader - Full Bias Levels",
          values: { AI_PD_VAH: "61215.3", AI_PD_VAL: "61120.9", AI_WEEKLY_BIAS: 1 },
        },
      ],
    };

    const map = getStudyValuesMap(indicators);
    assert.equal(map.AI_PD_VAH, "61215.3");
    assert.equal(map.AI_PD_VAL, "61120.9");
    assert.equal(map.AI_WEEKLY_BIAS, 1);
  });

  it("falls back to the last AI study when the exact name is missing", () => {
    const indicators = {
      studies: [
        {
          name: "Older AI Study",
          values: { AI_PD_VAH: "1" },
        },
        {
          name: "Another AI Study",
          values: { AI_PD_VAH: "2" },
        },
      ],
    };

    const study = getPrimaryStudy(indicators);
    assert.equal(study?.name, "Another AI Study");
    assert.equal(getStudyValuesMap(indicators).AI_PD_VAH, "2");
  });
});
