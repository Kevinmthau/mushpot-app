type QueryResult = {
  error: unknown;
};

type PostgrestErrorLike = {
  code?: unknown;
  message?: unknown;
};

export function isMissingCloneStatusColumnError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const { code, message } = error as PostgrestErrorLike;

  return (
    code === "42703" &&
    typeof message === "string" &&
    /(?:^|[^a-z0-9_])clone_status(?:[^a-z0-9_]|$)/i.test(message)
  );
}

export async function queryWithCloneStatusFallback<T extends QueryResult>(
  queryWithCloneStatus: () => PromiseLike<T>,
  queryWithoutCloneStatus: () => PromiseLike<T>,
): Promise<T> {
  const result = await queryWithCloneStatus();

  if (!isMissingCloneStatusColumnError(result.error)) {
    return result;
  }

  return queryWithoutCloneStatus();
}
