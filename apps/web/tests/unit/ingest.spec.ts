import { describe, expect, it } from "vitest";

import { activitySettled, type IngestActivity, type IngestItem } from "~/utils/ingest";
import { libraryStatusParam } from "~/utils/library";

function item(overrides: Partial<IngestItem>): IngestItem {
  return {
    task_id: "t",
    file_name: "a.pdf",
    created: null,
    done: null,
    source: "email",
    outcome: "duplicate",
    document: null,
    duplicate_of: null,
    message: null,
    ...overrides,
  };
}

function activity(items: IngestItem[]): IngestActivity {
  return {
    days: 7,
    items,
    mails: [],
    summary: { new: 0, duplicate: 0, failed: 0, running: 0, by_source: { email: 0, upload: 0, folder: 0 } },
    truncated: false,
  };
}

const doc = (tags: string[], missing = false) => ({ id: 1, title: "x", lifecycle_tags: tags, missing });

describe("activitySettled", () => {
  it("is settled with no data", () => {
    expect(activitySettled(undefined)).toBe(true);
  });
  it("keeps polling while a task runs", () => {
    expect(activitySettled(activity([item({ outcome: "running" })]))).toBe(false);
  });
  it.each([
    [[], false],
    [["ai-approved"], false],
    [["ai-pending"], true],
    [["ai-propagated"], true],
    [["ai-error"], true],
  ])("new document tagged %o → settled=%s", (tags, expected) => {
    expect(activitySettled(activity([item({ outcome: "new", document: doc(tags) })]))).toBe(expected);
  });
  it("does not wait on a document that no longer exists", () => {
    expect(activitySettled(activity([item({ outcome: "new", document: doc([], true) })]))).toBe(true);
  });
});

describe("libraryStatusParam", () => {
  it.each([
    ["error", "error"],
    ["review", ""],
    ["bogus", ""],
    ["", ""],
  ])("%s → %s", (raw, expected) => {
    expect(libraryStatusParam(raw)).toBe(expected);
  });
});
