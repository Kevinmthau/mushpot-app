import { describe, expect, it, vi } from "vitest";

import { applyShareUpdateWithLocalEditSignal } from "@/components/editor/editor-client";

describe("editor share reconciliation handoff", () => {
  it("signals a local mutation before applying confirmed share state", () => {
    const events: string[] = [];
    const onLocalEdit = vi.fn(() => events.push("local-edit"));
    const updateShareState = vi.fn(() => events.push("share-update"));

    applyShareUpdateWithLocalEditSignal(
      onLocalEdit,
      updateShareState,
      true,
      "share-token",
      "2026-08-17T14:00:00.000Z",
    );

    expect(events).toEqual(["local-edit", "share-update"]);
    expect(updateShareState).toHaveBeenCalledWith(
      true,
      "share-token",
      "2026-08-17T14:00:00.000Z",
    );
  });
});
