import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatRelativeTimestamp } from "@/lib/format-relative-time";

const NOW = new Date("2026-05-17T12:00:00.000Z");

function isoAgo(ms: number) {
  return new Date(NOW.getTime() - ms).toISOString();
}

function isoFromNow(ms: number) {
  return new Date(NOW.getTime() + ms).toISOString();
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatRelativeTimestamp", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'just now' for an invalid date string", () => {
    expect(formatRelativeTimestamp("not-a-date")).toBe("just now");
  });

  it("returns 'just now' for timestamps within 45 seconds", () => {
    expect(formatRelativeTimestamp(isoAgo(30 * SECOND))).toBe("just now");
  });

  it("formats past timestamps with an 'ago' suffix", () => {
    expect(formatRelativeTimestamp(isoAgo(2 * MINUTE))).toBe("2min ago");
    expect(formatRelativeTimestamp(isoAgo(2 * HOUR))).toBe("2hrs ago");
    expect(formatRelativeTimestamp(isoAgo(3 * DAY))).toBe("3d ago");
    expect(formatRelativeTimestamp(isoAgo(14 * DAY))).toBe("2w ago");
    expect(formatRelativeTimestamp(isoAgo(90 * DAY))).toBe("3mo ago");
    expect(formatRelativeTimestamp(isoAgo(730 * DAY))).toBe("2y ago");
  });

  it("formats future timestamps with a 'from now' suffix", () => {
    expect(formatRelativeTimestamp(isoFromNow(5 * MINUTE))).toBe(
      "5min from now",
    );
  });
});
