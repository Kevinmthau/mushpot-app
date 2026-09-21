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

type PrivateSessionContextValue = {
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
  const [writeSession, setWriteSession] = useState(() =>
    createDocumentWriteSession(initialUserId),
  );
  const sessionRef = useRef(writeSession);
  const mountGeneration = useRef(0);
  useEffect(() => {
    const lifetime = mountGeneration;
    const generation = ++lifetime.current;
    writeSession.activate();
    return () => {
      // Let child cleanup queue its final durable snapshot first. Explicit
      // sign-out still retires this session synchronously in clearUserId.
      queueMicrotask(() => {
        if (lifetime.current === generation) writeSession.deactivate();
      });
    };
  }, [writeSession]);
  const [userId, setCurrentUserId] = useState<string | null>(initialUserId);

  const setUserId = useCallback((nextUserId: string) => {
    if (!sessionRef.current.active || sessionRef.current.owner !== nextUserId) {
      sessionRef.current.deactivate();
      sessionRef.current = createDocumentWriteSession(nextUserId);
      setWriteSession(sessionRef.current);
    }
    setCurrentUserId((currentUserId) =>
      currentUserId === nextUserId ? currentUserId : nextUserId,
    );
  }, []);

  const clearUserId = useCallback(() => {
    sessionRef.current.deactivate();
    setCurrentUserId(null);
  }, []);

  const value = useMemo(
    () => ({
      clearUserId,
      setUserId,
      userId,
      writeSession,
    }),
    [clearUserId, setUserId, userId, writeSession],
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
