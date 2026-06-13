import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeYesterdayFakeoutsFromEvents,
} from "../src/core/brief_levels.js";
import {
  eventBrisbaneDateString,
  shiftBrisbaneDateString,
} from "../src/core/fakeout_log.js";

describe("brief_levels — fakeout summaries", () => {
  it("keeps non-current fakeouts in yesterday summary even without label fields", () => {
    const summary = summarizeYesterdayFakeoutsFromEvents([
      {
        confidence: "normal",
        level_set: "PD",
        level_side: "VAH",
      },
      {
        confidence: "low",
        level_set: "CUR",
        level_side: "VAL",
      },
      {
        confidence: "normal",
        label: "2D VAH",
      },
    ]);

    assert.equal(summary, "昨日已 fakeout：PD VAH / 2D VAH");
  });

  it("returns the event's Brisbane date when present and shifts dates safely", () => {
    assert.equal(
      eventBrisbaneDateString({ date: "2026-06-12" }),
      "2026-06-12",
    );
    assert.equal(
      eventBrisbaneDateString({
        date: "1970-01-22",
        bar_time: 1718179200,
      }),
      "2024-06-12",
    );
    assert.equal(shiftBrisbaneDateString("2026-06-12", -1), "2026-06-11");
    assert.equal(shiftBrisbaneDateString("2026-06-12", 1), "2026-06-13");
  });
});
