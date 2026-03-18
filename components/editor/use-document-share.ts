"use client";

import { useCallback, useMemo, useState } from "react";
import { customAlphabet } from "nanoid";

import { getSupabaseBrowserClient } from "@/lib/document-sync";

type UseDocumentShareParams = {
  documentId: string;
  getDocumentText: () => string;
  getDocumentTitle: () => string;
  onShareUpdated: (enabled: boolean, token: string | null) => void;
  shareEnabled: boolean;
  shareToken: string | null;
};

type BusyAction = "enable" | "rotate" | "disable" | "copyLink" | "copyText" | null;
type CopiedAction = "link" | "text" | null;

const tokenGenerator = customAlphabet(
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_",
  64,
);

export function useDocumentShare({
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
    if (
      typeof window === "undefined" ||
      !shareEnabled ||
      !shareToken
    ) {
      return "";
    }

    return `${window.location.origin}/s/${documentId}/${shareToken}`;
  }, [documentId, shareEnabled, shareToken]);

  const updateShareState = useCallback(
    async (enabled: boolean, token: string | null) => {
      const supabase = await getSupabaseBrowserClient();
      const { error: updateError } = await supabase
        .from("documents")
        .update({
          share_enabled: enabled,
          share_token: token,
        })
        .eq("id", documentId);

      if (updateError) {
        throw new Error(updateError.message);
      }

      onShareUpdated(enabled, token);
    },
    [documentId, onShareUpdated],
  );

  const buildDocumentClipboardText = useCallback(() => {
    const title = getDocumentTitle().trim();
    const content = getDocumentText();
    const trimmedContent = content.trim();

    if (title && trimmedContent) {
      return `${title}\n\n${content}`;
    }

    if (trimmedContent) {
      return content;
    }

    return title;
  }, [getDocumentText, getDocumentTitle]);

  const handleEnable = useCallback(async () => {
    setBusyAction("enable");
    setError(null);

    try {
      const nextToken = shareToken ?? tokenGenerator();
      await updateShareState(true, nextToken);
      setCopiedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to enable sharing.");
    } finally {
      setBusyAction(null);
    }
  }, [shareToken, updateShareState]);

  const handleRotate = useCallback(async () => {
    setBusyAction("rotate");
    setError(null);

    try {
      await updateShareState(true, tokenGenerator());
      setCopiedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to rotate link.");
    } finally {
      setBusyAction(null);
    }
  }, [updateShareState]);

  const handleDisable = useCallback(async () => {
    setBusyAction("disable");
    setError(null);

    try {
      await updateShareState(false, null);
      setCopiedAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to disable sharing.");
    } finally {
      setBusyAction(null);
    }
  }, [updateShareState]);

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
    const documentText = buildDocumentClipboardText();

    if (!documentText) {
      setError("Document is empty.");
      return;
    }

    setBusyAction("copyText");
    setError(null);

    try {
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
