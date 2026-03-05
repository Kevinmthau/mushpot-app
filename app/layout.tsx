import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";
import localFont from "next/font/local";

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
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
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
      </body>
    </html>
  );
}
