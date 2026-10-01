"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type UseDocumentHtmlDownloadParams = {
  owner: string;
  getLatestTitle: () => string;
  getLatestContent: () => string;
};

function downloadHtmlFile(html: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([html], { type: "text/html;charset=utf-8" }),
  );
  const link = document.createElement("a");

  try {
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Give the browser time to begin reading the file before releasing it.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export function useDocumentHtmlDownload({
  owner,
  getLatestTitle,
  getLatestContent,
}: UseDocumentHtmlDownloadParams) {
  const [isDownloading, setIsDownloading] = useState(false);
  const isMountedRef = useRef(true);
  const downloadControllerRef = useRef<AbortController | null>(null);
  const getLatestTitleRef = useRef(getLatestTitle);
  getLatestTitleRef.current = getLatestTitle;
  const getLatestContentRef = useRef(getLatestContent);
  getLatestContentRef.current = getLatestContent;

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      downloadControllerRef.current?.abort();
      downloadControllerRef.current = null;
    };
  }, []);

  const handleDownload = useCallback(async () => {
    if (!isMountedRef.current || downloadControllerRef.current) return;

    const controller = new AbortController();
    downloadControllerRef.current = controller;
    setIsDownloading(true);

    try {
      // Capture the local draft before the exporter chunk or media is loaded.
      const snapshot = {
        title: getLatestTitleRef.current(),
        content: getLatestContentRef.current(),
        owner,
      };
      const { exportDocumentHtml } = await import(
        "@/components/editor/document-html-export"
      );

      if (controller.signal.aborted) return;

      const { html, filename } = await exportDocumentHtml(snapshot, {
        signal: controller.signal,
      });

      if (controller.signal.aborted || !isMountedRef.current) return;

      downloadHtmlFile(html, filename);
    } catch (error) {
      if (controller.signal.aborted || !isMountedRef.current) return;

      const detail = error instanceof Error ? `${error.message} ` : "";
      window.alert(
        `Unable to download HTML. ${detail}Check your connection and try again.`,
      );
    } finally {
      if (downloadControllerRef.current === controller) {
        downloadControllerRef.current = null;
        if (isMountedRef.current) {
          setIsDownloading(false);
        }
      }
    }
  }, [owner]);

  return { isDownloading, handleDownload };
}
