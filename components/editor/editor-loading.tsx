const EDITOR_BODY_SKELETON_WIDTHS = ["w-full", "w-5/6", "w-4/6", "w-full", "w-3/4"];

export function EditorBodySkeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`space-y-3 ${className}`.trim()}>
      {EDITOR_BODY_SKELETON_WIDTHS.map((width, index) => (
        <div
          key={`${width}-${index}`}
          className={`h-4 animate-pulse rounded bg-[var(--line)] ${width}`}
        />
      ))}
    </div>
  );
}

export function EditorPreviewFallback({ initialValue }: { initialValue: string }) {
  const previewContent = initialValue.trim();

  if (!previewContent) {
    return <EditorBodySkeleton />;
  }

  return (
    <div className="max-h-[60vh] overflow-hidden whitespace-pre-wrap break-words font-[var(--font-writing)] text-[var(--doc-title-size-mobile)] leading-[1.75] text-[var(--ink)]">
      {previewContent}
    </div>
  );
}

export function EditorPageLoading() {
  return (
    <div className="min-h-dvh pb-14 sm:pb-20">
      <main className="mx-auto w-full max-w-[800px] px-4 pt-8 sm:px-5 sm:pt-12 md:px-0">
        <div className="mb-4 h-10 w-3/4 animate-pulse rounded bg-[var(--line)]" />
        <div className="mb-4 h-4 w-1/4 animate-pulse rounded bg-[var(--line)]" />
        <EditorBodySkeleton className="pt-4" />
      </main>
    </div>
  );
}
