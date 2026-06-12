import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  extractAiVpSnapshotFromPineLabels,
  getPrimaryStudy,
  getStudyValuesMap,
} from "../src/core/study_values.js";

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

  it("parses AI VP label text into a structured snapshot", () => {
    const pineLabels = {
      studies: [
        {
          name: "AI VP Reader - Full Bias Levels",
          labels: [
            {
              text:
                "AI VP Full\n" +
                "Daily: Bullish\n" +
                "Weekly: Bearish\n" +
                "CUR: 63597.7 / 63679.0 / 63531.6\n" +
                "PD: 62908.7 / 63371.6 / 62322.4\n" +
                "2D: 61215.8 / 62088.7 / 61120.9\n" +
                "PW: 60775.3 / 66849.9 / 59120.0\n" +
                "2W: 73563.9 / 75828.5 / 72550.9",
            },
          ],
        },
      ],
    };

    const snapshot = extractAiVpSnapshotFromPineLabels(pineLabels);
    assert.ok(snapshot);
    assert.equal(snapshot.dailyBias, "多頭");
    assert.equal(snapshot.weeklyBias, "空頭");
    assert.equal(snapshot.values.AI_CUR_VAH, "63679.0");
    assert.equal(snapshot.values.AI_2W_VAL, "72550.9");
  });
});
