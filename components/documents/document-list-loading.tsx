const DOCUMENT_ROW_WIDTHS = [65, 57, 49, 41, 33, 25];

export function DocumentListLoading() {
  return (
    <section
      aria-label="Loading documents"
      aria-live="polite"
      className="space-y-2"
      role="status"
    >
      <span className="sr-only">Loading documents…</span>
      <div aria-hidden="true" className="space-y-2">
        {DOCUMENT_ROW_WIDTHS.map((width) => (
          <div
            key={width}
            className="rounded-2xl bg-[var(--paper)] px-4 py-3 sm:px-5 sm:py-4"
          >
            <div
              className="h-5 animate-pulse rounded bg-[var(--line)]"
              style={{ width: `${width}%` }}
            />
            <div className="mt-2 h-3 w-16 animate-pulse rounded bg-[var(--line)]" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function DocumentsPageLoading() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6 flex items-center justify-end sm:mb-10">
        <div
          aria-hidden="true"
          className="h-10 w-20 animate-pulse rounded-xl bg-[var(--line)]"
        />
      </header>

      <DocumentListLoading />
    </main>
  );
}
