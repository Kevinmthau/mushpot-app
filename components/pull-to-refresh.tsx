"use client";

import { useRouter } from "next/navigation";
import {
  useRef,
  useState,
  useCallback,
  useTransition,
  type ReactNode,
} from "react";

const THRESHOLD = 80;
const MAX_PULL = 120;

export default function PullToRefresh({
  children,
  onRefresh,
}: {
  children: ReactNode;
  onRefresh?: () => Promise<void> | void;
}) {
  const router = useRouter();
  const [pullDistance, setPullDistance] = useState(0);
  const [isPending, startTransition] = useTransition();
  const touchStartY = useRef(0);
  const pulling = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (window.scrollY === 0) {
      touchStartY.current = e.touches[0].clientY;
      pulling.current = true;
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!pulling.current) return;

    const delta = e.touches[0].clientY - touchStartY.current;
    if (delta > 0) {
      setPullDistance(Math.min(delta * 0.5, MAX_PULL));
    } else {
      pulling.current = false;
      setPullDistance(0);
    }
  }, []);

  const onTouchEnd = useCallback(() => {
    if (!pulling.current) return;
    pulling.current = false;

    if (pullDistance >= THRESHOLD) {
      startTransition(() => {
        if (onRefresh) {
          void onRefresh();
          return;
        }

        router.refresh();
      });
    }
    setPullDistance(0);
  }, [onRefresh, pullDistance, router]);

  const isActive = pullDistance > 0 || isPending;
  const progress = Math.min(pullDistance / THRESHOLD, 1);

  return (
    <div
      ref={containerRef}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      className="relative"
    >
      {/* Pull indicator */}
      <div
        className="pointer-events-none absolute left-0 right-0 flex justify-center overflow-hidden"
        style={{ height: isActive ? Math.max(pullDistance, isPending ? 40 : 0) : 0 }}
      >
        <div
          className="mt-2"
          style={{
            opacity: isPending ? 1 : progress,
            transform: `rotate(${isPending ? 0 : progress * 180}deg)`,
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`text-[var(--muted)] ${isPending ? "animate-spin" : ""}`}
          >
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        </div>
      </div>

      {/* Content */}
      <div
        style={{
          transform: isActive
            ? `translateY(${isPending ? 40 : pullDistance}px)`
            : undefined,
          transition: pullDistance === 0 ? "transform 0.2s ease" : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
