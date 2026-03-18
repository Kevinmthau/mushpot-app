export type EditorDocument = {
  id: string;
  owner: string;
  title: string;
  content: string;
  updated_at: string;
  share_enabled: boolean;
  share_token: string | null;
};

export type EditorClientProps = {
  initialDocument: EditorDocument;
};
