import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildAiVpSnapshotFromStudyValues,
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

  it("builds an AI VP snapshot directly from study values", () => {
    const indicators = {
      studies: [
        {
          name: "AI VP Reader - Full Bias Levels",
          values: {
            AI_WEEKLY_BIAS: -1,
            AI_DAILY_BIAS: 1,
            AI_CUR_POC: "63597.7",
            AI_CUR_VAH: "63679.0",
            AI_CUR_VAL: "63531.6",
            AI_PD_POC: "62908.7",
            AI_PD_VAH: "63371.6",
            AI_PD_VAL: "62322.4",
            AI_2D_POC: "61215.8",
            AI_2D_VAH: "62088.7",
            AI_2D_VAL: "61120.9",
            AI_PW_POC: "60775.3",
            AI_PW_VAH: "66849.9",
            AI_PW_VAL: "59120.0",
            AI_2W_POC: "73563.9",
            AI_2W_VAH: "75828.5",
            AI_2W_VAL: "72550.9",
          },
        },
      ],
    };

    const snapshot = buildAiVpSnapshotFromStudyValues(indicators);
    assert.ok(snapshot);
    assert.equal(snapshot.source, "data_window");
    assert.equal(snapshot.dailyBias, "多頭");
    assert.equal(snapshot.weeklyBias, "空頭");
    assert.equal(snapshot.values.AI_PD_VAH, "63371.6");
    assert.equal(snapshot.levels.w2.val, "72550.9");
  });
});
