"use client";

import dynamic from "next/dynamic";

const PrivateStartup = dynamic(
  () => import("@/components/pwa/private-startup").then((module) => module.PrivateStartup),
  {
    ssr: false,
  },
);

export function PrivateStartupSlot() {
  return <PrivateStartup />;
}
