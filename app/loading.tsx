export default function HomeLoading() {
  return (
    <main className="mx-auto min-h-dvh w-full max-w-[880px] px-4 py-8 sm:px-6 sm:py-12">
      <header className="mb-6 flex items-center justify-end sm:mb-10">
        <div className="h-10 w-20 animate-pulse rounded-xl bg-[var(--line)]" />
      </header>

      <section className="space-y-2">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="rounded-2xl bg-[var(--paper)] px-4 py-3 sm:px-5 sm:py-4"
          >
            <div className="h-5 animate-pulse rounded bg-[var(--line)]" style={{ width: `${65 - i * 8}%` }} />
            <div className="mt-2 h-3 w-16 animate-pulse rounded bg-[var(--line)]" />
          </div>
        ))}
      </section>
    </main>
  );
}
