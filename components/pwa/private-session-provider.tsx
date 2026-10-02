"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  createDocumentWriteSession,
  type DocumentWriteSession,
} from "@/lib/document-write-coordinator";

import { subscribeToAuthLifecycleEvents } from "@/lib/auth-lifecycle-events";
import { createDocumentListSession, type DocumentListSession } from "@/lib/document-list-session";

function createPrivateSession(owner: string) {
  const writeSession = createDocumentWriteSession(owner);
  return { writeSession, documentListSession: createDocumentListSession(writeSession) };
}

type PrivateSessionContextValue = {
  documentListSession: DocumentListSession;
  writeSession: DocumentWriteSession;
  clearUserId: () => void;
  setUserId: (userId: string) => void;
  userId: string | null;
};

const PrivateSessionContext = createContext<PrivateSessionContextValue | null>(
  null,
);

export function PrivateSessionProvider({
  children,
  initialUserId,
}: {
  children?: ReactNode;
  initialUserId: string;
}) {
  const [session, setSession] = useState(() => createPrivateSession(initialUserId));
  const { writeSession, documentListSession } = session;
  const sessionRef = useRef(session);
  const mountGeneration = useRef(0);
  useEffect(() => {
    const lifetime = mountGeneration;
    const generation = ++lifetime.current;
    writeSession.activate();
    documentListSession.observe();
    const unsubscribe = subscribeToAuthLifecycleEvents({
      onExplicitSignOutStarted: (owner) => {
        if (documentListSession.owner === owner) documentListSession.retire();
      },
      onSessionRecovered: () => {},
    });
    return () => {
      unsubscribe();
      // Let child cleanup queue its final durable snapshot first. Explicit
      // sign-out still retires this session synchronously in clearUserId.
      queueMicrotask(() => {
        if (lifetime.current === generation) {
          writeSession.deactivate();
          documentListSession.retire();
        }
      });
    };
  }, [documentListSession, writeSession]);
  const [userId, setCurrentUserId] = useState<string | null>(initialUserId);

  const setUserId = useCallback((nextUserId: string) => {
    const current = sessionRef.current;
    if (!current.writeSession.active || !current.documentListSession.active ||
        current.writeSession.owner !== nextUserId) {
      current.writeSession.deactivate();
      current.documentListSession.retire();
      sessionRef.current = createPrivateSession(nextUserId);
      setSession(sessionRef.current);
    }
    setCurrentUserId((currentUserId) =>
      currentUserId === nextUserId ? currentUserId : nextUserId,
    );
  }, []);

  const clearUserId = useCallback(() => {
    sessionRef.current.writeSession.deactivate();
    sessionRef.current.documentListSession.retire();
    setCurrentUserId(null);
  }, []);

  const value = useMemo(
    () => ({
      clearUserId,
      documentListSession,
      setUserId,
      userId,
      writeSession,
    }),
    [clearUserId, documentListSession, setUserId, userId, writeSession],
  );

  return (
    <PrivateSessionContext.Provider value={value}>
      {children}
    </PrivateSessionContext.Provider>
  );
}

export function usePrivateSession() {
  const context = useContext(PrivateSessionContext);

  if (!context) {
    throw new Error(
      "usePrivateSession must be used within PrivateSessionProvider.",
    );
  }

  return context;
}
