import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";
import localFont from "next/font/local";

import { ServiceWorkerRegister } from "@/components/pwa/service-worker-register";

import "./globals.css";

const uiFont = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-ui",
});

const writingFont = localFont({
  src: [
    {
      path: "./fonts/iAWriterDuoS-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/iAWriterDuoS-Italic.woff2",
      weight: "400",
      style: "italic",
    },
    {
      path: "./fonts/iAWriterDuoS-Bold.woff2",
      weight: "700",
      style: "normal",
    },
    {
      path: "./fonts/iAWriterDuoS-BoldItalic.woff2",
      weight: "700",
      style: "italic",
    },
  ],
  variable: "--font-writing",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Mushpot",
  description: "A focused, distraction-free writing canvas.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Mushpot",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#2f5966",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${uiFont.variable} ${writingFont.variable} antialiased`}>
        {children}
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
