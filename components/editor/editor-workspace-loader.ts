"use client";

type EditorWorkspaceModule = typeof import("@/components/editor/editor-workspace");

let editorWorkspaceModulePromise: Promise<EditorWorkspaceModule> | null = null;
let resolvedEditorWorkspace: EditorWorkspaceModule["EditorWorkspace"] | null = null;

export function getLoadedEditorWorkspace() {
  return resolvedEditorWorkspace;
}

export function preloadEditorWorkspace() {
  if (!editorWorkspaceModulePromise) {
    editorWorkspaceModulePromise = import("@/components/editor/editor-workspace")
      .then((module) => {
        resolvedEditorWorkspace = module.EditorWorkspace;
        return module;
      })
      .catch((error) => {
        editorWorkspaceModulePromise = null;
        throw error;
      });
  }

  return editorWorkspaceModulePromise;
}
