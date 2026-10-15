"use client";

import { useCallback, useMemo, useState } from "react";
import { customAlphabet } from "nanoid";

import { getConfiguredAppOrigin } from "@/lib/app-url";
import {
  type DocumentContentFormat,
  getDocumentPlainText,
  parseDocumentContentFormat,
} from "@/lib/page-document";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

type UseDocumentShareParams = {
  contentFormat: DocumentContentFormat;
  documentId: string;
  getDocumentText: () => string | null;
  getDocumentTitle: () => string;
  onShareUpdated: (
    enabled: boolean,
    token: string | null,
    updatedAt: string,
    body?: {
      title: string;
      content: string;
      content_format: DocumentContentFormat;
    },
  ) => void;
  shareEnabled: boolean;
  shareToken: string | null;
};

type BusyAction = "enable" | "rotate" | "disable" | "copyLink" | "copyText" | null;
type CopiedAction = "link" | "text" | null;

const tokenGenerator = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_",
  64,
);

function resolveShareOrigin() {
  const configuredAppOrigin = getConfiguredAppOrigin();
  if (configuredAppOrigin) {
    return configuredAppOrigin;
  }

  if (typeof window === "undefined") {
    return "";
  }

  return window.location.origin;
}

export function useDocumentShare({
  contentFormat,
  documentId,
  getDocumentText,
  getDocumentTitle,
  onShareUpdated,
  shareEnabled,
  shareToken,
}: UseDocumentShareParams) {
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedAction, setCopiedAction] = useState<CopiedAction>(null);

  const shareUrl = useMemo(() => {
    if (!shareEnabled || !shareToken) {
      return "";
    }

    const origin = resolveShareOrigin();
    if (!origin) {
      return "";
    }

    return `${origin}/s/${documentId}/${shareToken}`;
  }, [documentId, shareEnabled, shareToken]);

  const persistShareState = useCallback(
    async (enabled: boolean, token: string | null) => {
      const supabase = await getSupabaseBrowserClient();
      const { data, error: updateError } = await supabase
        .from("documents")
        .update({
          share_enabled: enabled,
          share_token: token,
        })
        .eq("id", documentId)
        .select("title, content, content_format, updated_at")
        .single();

      if (updateError) {
        throw new Error(updateError.message);
      }

      if (!data?.updated_at) {
        throw new Error("Unable to update sharing settings.");
      }

      onShareUpdated(enabled, token, data.updated_at, {
        title: data.title,
        content: data.content,
        content_format: parseDocumentContentFormat(data.content_format),
      });
    },
    [documentId, onShareUpdated],
  );

  const buildDocumentClipboardText = useCallback(() => {
    const title = getDocumentTitle().trim();
    const serializedDocument = getDocumentText();
    if (serializedDocument === null) return null;
    const content = getDocumentPlainText(
      serializedDocument,
      parseDocumentContentFormat(contentFormat),
    );
    const trimmedContent = content.trim();

    if (title && trimmedContent) {
      return `${title}\n\n${content}`;
    }

    if (trimmedContent) {
      return content;
    }

    return title;
  }, [contentFormat, getDocumentText, getDocumentTitle]);

  const handleEnable = useCallback(async () => {
    setBusyAction("enable");
    setError(null);

    try {
      const nextToken = shareToken ?? tokenGenerator();
      await persistShareState(true, nextToken);
      setCopiedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enable sharing.");
    } finally {
      setBusyAction(null);
    }
  }, [persistShareState, shareToken]);

  const handleRotate = useCallback(async () => {
    setBusyAction("rotate");
    setError(null);

    try {
      await persistShareState(true, tokenGenerator());
      setCopiedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rotate link.");
    } finally {
      setBusyAction(null);
    }
  }, [persistShareState]);

  const handleDisable = useCallback(async () => {
    setBusyAction("disable");
    setError(null);

    try {
      await persistShareState(false, null);
      setCopiedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to disable sharing.");
    } finally {
      setBusyAction(null);
    }
  }, [persistShareState]);

  const handleCopyLink = useCallback(async () => {
    if (!shareUrl) {
      return;
    }

    setBusyAction("copyLink");
    setError(null);

    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedAction("link");
    } catch {
      setError("Clipboard access was blocked. Copy manually.");
    } finally {
      setBusyAction(null);
    }
  }, [shareUrl]);

  const handleCopyText = useCallback(async () => {
    setBusyAction("copyText");
    setError(null);

    try {
      const documentText = buildDocumentClipboardText();
      if (documentText === null) {
        setError("This page can’t be copied until its latest change can be saved.");
        return;
      }
      if (!documentText) {
        setError("Document is empty.");
        return;
      }
      await navigator.clipboard.writeText(documentText);
      setCopiedAction("text");
    } catch {
      setError("Clipboard access was blocked. Copy manually.");
    } finally {
      setBusyAction(null);
    }
  }, [buildDocumentClipboardText]);

  return {
    busyAction,
    copiedAction,
    error,
    handleCopyLink,
    handleCopyText,
    handleDisable,
    handleEnable,
    handleRotate,
    shareUrl,
  };
}
