import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Roboto_Mono } from "next/font/google";

import "./globals.css";

const uiFont = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-ui",
});

const writingFont = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-writing",
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
