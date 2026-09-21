import type { Text } from "@codemirror/state";

import type { EditorDocument } from "@/components/editor/editor-types";
import { readDocumentText } from "@/components/editor/read-document-text";
import {
  createDraftPageLifecycleHandlers,
  createInitialDraftPersistenceGate,
  getMostRecentTimestamp,
  hasUnsavedDocumentChanges,
  isIncomingHydrationStale,
  openInitialDraftPersistenceGate,
  reconcileDraftHydration,
  requestInitialDraftPersistence,
} from "@/components/editor/draft-controller-policy";
import type { CachedDocument } from "@/lib/doc-cache";
import {
  normalizeDocumentTitle,
  type PersistableDocumentSnapshot,
  type PersistDocumentResult,
} from "@/lib/document-sync";
import type { DocumentWriteEvent } from "@/lib/document-write-coordinator";

export type DraftSaveStatus = "saved" | "saving" | "retryable" | "conflict";
export type DraftViewState = {
  contentForStats: string;
  isDeleting: boolean;
  needsDraftRecovery: boolean;
  saveStatus: DraftSaveStatus;
  shareEnabled: boolean;
  shareToken: string | null;
  title: string;
  updatedAt: string;
};

export type DraftPersistenceOptions = {
  canPersist?: () => boolean;
  cache: (document: CachedDocument) => Promise<boolean>;
  persist: (
    snapshot: PersistableDocumentSnapshot,
  ) => Promise<PersistDocumentResult>;
  subscribe?: (listener: (event: DocumentWriteEvent) => void) => () => void;
};

/** Owns the draft independently of React. Text is serialized only when consumed. */
export class DocumentDraftController {
  private source: Text | string;
  private serializedSource: Text | string;
  private serialized: string;
  private saved: { content: string; title: string; updatedAt: string };
  private cachedDirty: boolean;
  private baseVersionUntrusted: boolean;
  private revision: number;
  private edited = false;
  private mutations = { content: false, share: false, title: false };
  private gate;
  private view: DraftViewState;
  private listeners = new Set<(view: DraftViewState) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private active = false;
  private generation = 0;
  private persistenceGeneration = 0;

  constructor(
    private document: EditorDocument,
    resolved: boolean,
    private options: DraftPersistenceOptions,
  ) {
    this.source = this.serializedSource = this.serialized = document.content;
    this.saved = {
      content: document.content,
      title: normalizeDocumentTitle(document.title),
      updatedAt: document.updated_at,
    };
    this.cachedDirty = document._dirty === true;
    this.baseVersionUntrusted = document._baseVersionUntrusted === true;
    this.revision = document._localUpdatedAt ?? Date.now();
    this.gate = createInitialDraftPersistenceGate(resolved || this.cachedDirty);
    this.view = {
      contentForStats: document.content,
      isDeleting: false,
      needsDraftRecovery: this.baseVersionUntrusted,
      saveStatus: this.cachedDirty ? "retryable" : "saved",
      shareEnabled: document.share_enabled,
      shareToken: document.share_token,
      title: document.title,
      updatedAt: document.updated_at,
    };
  }

  /** Rebind authentication without replacing the user's in-memory draft. */
  setPersistence(options: DraftPersistenceOptions) {
    if (this.options !== options) {
      this.options = options;
      this.persistenceGeneration += 1;
    }
  }

  getView = () => this.view;
  getLatestTitle = () => this.view.title;
  getLatestContent = () => {
    if (this.source !== this.serializedSource) {
      this.serialized = readDocumentText(this.source);
      this.serializedSource = this.source;
    }
    return this.serialized;
  };

  private publish(update: Partial<DraftViewState>) {
    this.view = { ...this.view, ...update };
    if (this.active) for (const listener of this.listeners) listener(this.view);
  }

  private schedule(key: string, delay: number, work: () => void) {
    const previous = this.timers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    if (!this.active || this.view.isDeleting) return;
    const generation = this.generation;
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        if (this.active && generation === this.generation) work();
      }, delay),
    );
  }

  private clearScheduledWork = () => {
    this.generation += 1;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  };

  private isDirty() {
    return hasUnsavedDocumentChanges({
      cachedDraftIsDirty: this.cachedDirty,
      latestContent: this.getLatestContent(),
      latestTitle: normalizeDocumentTitle(this.view.title),
      savedContent: this.saved.content,
      savedTitle: this.saved.title,
    });
  }

  private snapshot(): CachedDocument {
    return {
      id: this.document.id,
      owner: this.document.owner,
      title: normalizeDocumentTitle(this.view.title),
      content: this.getLatestContent(),
      // Display timestamps can include share changes; only a verified body
      // snapshot can advance the optimistic-concurrency baseline.
      updated_at: this.saved.updatedAt,
      share_enabled: this.view.shareEnabled,
      share_token: this.view.shareToken,
      _localUpdatedAt: this.revision,
      _dirty: this.isDirty(),
      _baseVersionUntrusted: this.baseVersionUntrusted,
    };
  }

  private cache = () => {
    if (this.view.isDeleting) return Promise.resolve(false);
    return this.options.cache(this.snapshot()).catch(() => false);
  };

  private acceptWrite = ({ snapshot, result }: DocumentWriteEvent) => {
    if (
      this.view.isDeleting ||
      snapshot.id !== this.document.id ||
      snapshot.owner !== this.document.owner
    )
      return;
    if (result.status === "conflict") {
      this.cachedDirty = true;
      this.publish({ saveStatus: "conflict" });
      void this.cache();
      return;
    }
    if (
      result.status !== "saved" ||
      !result.updatedAt ||
      this.view.saveStatus === "conflict"
    )
      return;
    if (isIncomingHydrationStale(this.saved.updatedAt, result.updatedAt))
      return;
    this.saved = {
      content: snapshot.content,
      title: result.persistedTitle,
      updatedAt: result.updatedAt,
    };
    this.cachedDirty = false;
    this.baseVersionUntrusted = false;
    this.publish({
      ...(!this.mutations.share && result.confirmedSnapshot
        ? {
            shareEnabled: result.confirmedSnapshot.share_enabled,
            shareToken: result.confirmedSnapshot.share_token,
          }
        : {}),
      needsDraftRecovery: false,
      saveStatus: this.isDirty() ? "saving" : "saved",
      updatedAt: getMostRecentTimestamp(this.view.updatedAt, result.updatedAt),
    });
    // A newer local snapshot may have prevented the save's clean-cache write.
    // Keep that text dirty but advance it to this confirmed local save version.
    void this.cache();
  };

  save = async () => {
    if (
      this.options.canPersist?.() === false ||
      this.view.isDeleting ||
      this.view.saveStatus === "conflict" ||
      !this.isDirty()
    )
      return;
    if (!requestInitialDraftPersistence(this.gate)) return;
    const snapshot = this.snapshot();
    const generation = this.generation;
    const persistenceGeneration = this.persistenceGeneration;
    this.publish({ saveStatus: "saving" });
    try {
      const result = await this.options.persist(snapshot);
      if (persistenceGeneration !== this.persistenceGeneration) return;
      this.acceptWrite({ snapshot, result });
      if (result.status === "retryable" || result.status === "cancelled")
        this.retry(generation);
      if (result.status === "superseded")
        this.publish({ saveStatus: "conflict" });
    } catch {
      if (persistenceGeneration === this.persistenceGeneration)
        this.retry(generation);
    }
  };

  private retry(generation: number) {
    if (this.view.isDeleting || this.view.saveStatus === "conflict") return;
    this.publish({ saveStatus: "retryable" });
    if (generation === this.generation && this.options.canPersist?.() !== false)
      this.schedule("save", 30_000, () => {
        void this.save();
      });
  }

  private changed() {
    this.edited = true;
    this.revision = Math.max(Date.now(), this.revision + 1);
    this.schedule("cache", 400, () => {
      void this.cache();
    });
    if (this.view.saveStatus !== "conflict")
      this.schedule("save", 800, () => {
        void this.save();
      });
  }

  handleEditorChange = (source: Text) => {
    this.source = source;
    this.mutations.content = true;
    this.changed();
    this.schedule("stats", 250, () =>
      this.publish({ contentForStats: this.getLatestContent() }),
    );
  };

  handleTitleChange = (title: string) => {
    this.mutations.title = true;
    this.publish({ title });
    this.changed();
  };

  handleTitleBlur = () => {
    if (!this.view.title.trim()) this.handleTitleChange("Untitled");
  };

  hydrate(document: EditorDocument, resolved: boolean) {
    if (
      this.view.saveStatus !== "conflict" &&
      !isIncomingHydrationStale(this.saved.updatedAt, document.updated_at)
    ) {
      const content = this.getLatestContent();
      const legacyOverlap =
        this.baseVersionUntrusted &&
        this.cachedDirty &&
        (document.content !== content ||
          normalizeDocumentTitle(document.title) !==
            normalizeDocumentTitle(this.view.title));
      const overlaps =
        legacyOverlap ||
        (document.updated_at !== this.saved.updatedAt &&
          ((this.mutations.content &&
            document.content !== this.saved.content &&
            document.content !== content) ||
            (this.mutations.title &&
              document.title !== this.saved.title &&
              document.title !== this.view.title)));
      if (overlaps) {
        this.cachedDirty = true;
        this.publish({ saveStatus: "conflict" });
        void this.cache();
      } else {
        const next = reconcileDraftHydration(
          {
            content,
            isDeleting: this.view.isDeleting,
            savedContent: this.saved.content,
            savedTitle: this.saved.title,
            savedUpdatedAt: this.saved.updatedAt,
            shareEnabled: this.view.shareEnabled,
            shareToken: this.view.shareToken,
            title: this.view.title,
            updatedAt: this.view.updatedAt,
          },
          document,
          this.mutations,
        );
        if (!this.mutations.content) this.source = next.content;
        this.saved = {
          content: next.savedContent,
          title: next.savedTitle,
          updatedAt: next.savedUpdatedAt,
        };
        this.cachedDirty = document._dirty === true;
        this.baseVersionUntrusted = document._baseVersionUntrusted === true;
        this.publish({
          needsDraftRecovery: this.baseVersionUntrusted,
          contentForStats: this.getLatestContent(),
          title: next.title,
          updatedAt: next.updatedAt,
          shareEnabled: next.shareEnabled,
          shareToken: next.shareToken,
        });
        if (this.edited)
          this.schedule("cache", 400, () => {
            void this.cache();
          });
      }
    }
    if (resolved) {
      const deferred = openInitialDraftPersistenceGate(this.gate);
      if (deferred || this.cachedDirty || this.edited)
        this.schedule("save", 0, () => {
          void this.save();
        });
    }
  }

  updateShareState = (
    enabled: boolean,
    token: string | null,
    updatedAt: string,
    body?: { content: string; title: string },
  ) => {
    this.edited = true;
    this.mutations.share = true;
    this.publish({
      shareEnabled: enabled,
      shareToken: token,
      updatedAt: getMostRecentTimestamp(this.view.updatedAt, updatedAt),
    });
    // The sharing update returns the body from the same database row. Only
    // adopt its version when that body is still our confirmed save baseline.
    if (
      body &&
      body.content === this.saved.content &&
      body.title === this.saved.title &&
      !this.cachedDirty &&
      !this.baseVersionUntrusted &&
      this.view.saveStatus !== "conflict"
    ) {
      this.saved.updatedAt = getMostRecentTimestamp(
        this.saved.updatedAt,
        updatedAt,
      );
    }
    void this.cache();
  };

  flushLatestDraft = async () => {
    this.clearScheduledWork();
    const cacheWrite = this.cache();
    void this.save();
    await cacheWrite;
  };

  markDeleting = () => {
    this.publish({ isDeleting: true });
    this.clearScheduledWork();
  };

  resetDeletingState = () => {
    this.publish({ isDeleting: false });
    this.schedule("save", 800, () => {
      void this.save();
    });
  };

  start(listener: (view: DraftViewState) => void) {
    this.active = true;
    this.listeners.add(listener);
    listener(this.view);
    const persistenceGeneration = this.persistenceGeneration;
    const unsubscribe = this.options.subscribe?.((event) => {
      if (persistenceGeneration === this.persistenceGeneration)
        this.acceptWrite(event);
    });
    if (this.isDirty()) {
      void this.cache();
      this.schedule("save", 800, () => {
        void this.save();
      });
    }
    const lifecycle = createDraftPageLifecycleHandlers({
      clearScheduledWork: this.clearScheduledWork,
      isDeleting: () => this.view.isDeleting,
      saveLatestDraft: () => {
        void this.save();
      },
      writeLocalCacheSnapshot: () => {
        if (this.edited || this.cachedDirty) void this.cache();
      },
    });
    return {
      ...lifecycle,
      stop: () => {
        lifecycle.handleUnmount();
        this.active = false;
        this.listeners.delete(listener);
        unsubscribe?.();
      },
    };
  }
}
