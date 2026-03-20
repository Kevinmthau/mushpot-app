import { readFile } from "node:fs/promises";
import path from "node:path";

import { ImageResponse } from "next/og";

import {
  buildSharedDocumentPreview,
  fetchSharedDocument,
  normalizeSharedDocumentTitle,
} from "@/lib/shared-document";

export const alt = "Shared document preview";
export const contentType = "image/png";
export const dynamic = "force-dynamic";
export const size = {
  width: 1200,
  height: 630,
};

const writingFontRegular = readFile(
  path.join(process.cwd(), "app/fonts/iAWriterDuoS-Regular.woff2"),
);
const writingFontBold = readFile(
  path.join(process.cwd(), "app/fonts/iAWriterDuoS-Bold.woff2"),
);

type SharedDocImageProps = {
  params: Promise<{ id: string; token: string }>;
};

export default async function OpenGraphImage({ params }: SharedDocImageProps) {
  const { id, token } = await params;
  const document = await fetchSharedDocument(id, token);
  const title = normalizeSharedDocumentTitle(document?.title ?? "Shared document");
  const excerpt = buildSharedDocumentPreview(document?.content ?? "", 220);
  const [regularFont, boldFont] = await Promise.all([
    writingFontRegular,
    writingFontBold,
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          padding: "36px",
          background:
            "linear-gradient(145deg, rgb(250, 245, 236) 0%, rgb(240, 233, 220) 48%, rgb(222, 232, 231) 100%)",
          color: "rgb(31, 47, 52)",
        }}
      >
        <div
          style={{
            display: "flex",
            width: "100%",
            height: "100%",
            flexDirection: "column",
            justifyContent: "space-between",
            borderRadius: "28px",
            border: "2px solid rgba(47, 89, 102, 0.14)",
            background: "rgba(255, 252, 247, 0.86)",
            boxShadow: "0 18px 48px rgba(47, 89, 102, 0.12)",
            padding: "44px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: '"iA Writer Duo S", serif',
              fontSize: "24px",
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: "rgb(90, 116, 123)",
            }}
          >
            <span>Shared from Mushpot</span>
            <span>Document</span>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "24px",
              maxWidth: "94%",
            }}
          >
            <div
              style={{
                display: "flex",
                fontFamily: '"iA Writer Duo S", serif',
                fontSize: title.length > 60 ? "54px" : "68px",
                fontWeight: 700,
                lineHeight: 1.08,
                whiteSpace: "pre-wrap",
                color: "rgb(31, 47, 52)",
              }}
            >
              {title}
            </div>

            <div
              style={{
                display: "flex",
                fontFamily: '"iA Writer Duo S", serif',
                fontSize: "30px",
                lineHeight: 1.35,
                whiteSpace: "pre-wrap",
                color: "rgb(86, 103, 109)",
              }}
            >
              {excerpt}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontFamily: '"iA Writer Duo S", serif',
              fontSize: "24px",
              color: "rgb(105, 118, 123)",
            }}
          >
            <span>Focused writing, shared cleanly.</span>
            <span>Mushpot</span>
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: "iA Writer Duo S",
          data: regularFont,
          style: "normal",
          weight: 400,
        },
        {
          name: "iA Writer Duo S",
          data: boldFont,
          style: "normal",
          weight: 700,
        },
      ],
    },
  );
}
