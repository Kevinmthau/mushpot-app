"use client";

import dynamic from "next/dynamic";

const EditorClient = dynamic(
  () =>
    import("@/components/editor/editor-client").then(
      (module) => module.EditorClient,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <div className="mb-4 h-10 w-3/4 animate-pulse rounded bg-[var(--line)]" />
        <div className="mb-4 h-4 w-1/4 animate-pulse rounded bg-[var(--line)]" />
        <div className="space-y-3">
          <div className="h-4 w-full animate-pulse rounded bg-[var(--line)]" />
          <div className="h-4 w-5/6 animate-pulse rounded bg-[var(--line)]" />
          <div className="h-4 w-4/6 animate-pulse rounded bg-[var(--line)]" />
        </div>
      </div>
    ),
  },
);

export { EditorClient };
