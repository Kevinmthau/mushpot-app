// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DraftRecoveryNotice } from "@/components/editor/draft-recovery-notice";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("draft recovery notice", () => {
  it("explains the sync block and lets the writer save a copy", async () => {
    const onSaveCopy = vi.fn();
    await act(async () => {
      root.render(createElement(DraftRecoveryNotice, {
        isCloning: false,
        isDeleting: false,
        onSaveCopy,
      }));
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "This draft is saved on this device but can’t sync automatically.",
    );
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Save a copy");
    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(onSaveCopy).toHaveBeenCalledOnce();
  });

  it.each([
    { isCloning: true, isDeleting: false, label: "Saving copy…" },
    { isCloning: false, isDeleting: true, label: "Save a copy" },
  ])("prevents recovery during cloning=$isCloning, deleting=$isDeleting", async ({
    isCloning,
    isDeleting,
    label,
  }) => {
    const onSaveCopy = vi.fn();
    await act(async () => {
      root.render(createElement(DraftRecoveryNotice, {
        isCloning,
        isDeleting,
        onSaveCopy,
      }));
    });

    const button = container.querySelector("button")!;
    expect(button.textContent).toBe(label);
    expect(button.disabled).toBe(true);
    await act(async () => button.click());
    expect(onSaveCopy).not.toHaveBeenCalled();
  });
});
