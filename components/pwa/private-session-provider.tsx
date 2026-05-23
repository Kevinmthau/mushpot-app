"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type PrivateSessionContextValue = {
  clearUserId: () => void;
  setUserId: (userId: string) => void;
  userId: string | null;
};

const PrivateSessionContext = createContext<PrivateSessionContextValue | null>(null);

export function PrivateSessionProvider({
  children,
  initialUserId,
}: {
  children: ReactNode;
  initialUserId: string;
}) {
  const [userId, setCurrentUserId] = useState<string | null>(initialUserId);

  const setUserId = useCallback((nextUserId: string) => {
    setCurrentUserId((currentUserId) =>
      currentUserId === nextUserId ? currentUserId : nextUserId,
    );
  }, []);

  const clearUserId = useCallback(() => {
    setCurrentUserId(null);
  }, []);

  const value = useMemo(
    () => ({
      clearUserId,
      setUserId,
      userId,
    }),
    [clearUserId, setUserId, userId],
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
    throw new Error("usePrivateSession must be used within PrivateSessionProvider.");
  }

  return context;
}
