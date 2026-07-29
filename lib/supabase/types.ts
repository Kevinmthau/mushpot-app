export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      documents: {
        Row: {
          id: string;
          owner: string;
          title: string;
          content: string;
          share_enabled: boolean;
          share_token: string | null;
          clone_status: "pending" | "recovering" | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner: string;
          title?: string;
          content?: string;
          share_enabled?: boolean;
          share_token?: string | null;
          clone_status?: "pending" | "recovering" | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner?: string;
          title?: string;
          content?: string;
          share_enabled?: boolean;
          share_token?: string | null;
          clone_status?: "pending" | "recovering" | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "documents_owner_fkey";
            columns: ["owner"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      document_media_cleanup_jobs: {
        Row: {
          document_id: string;
          owner: string;
          created_at: string;
        };
        Insert: {
          document_id: string;
          owner: string;
          created_at?: string;
        };
        Update: {
          document_id?: string;
          owner?: string;
          created_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_media_cleanup_jobs_owner_fkey";
            columns: ["owner"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      delete_document_with_media_cleanup_job: {
        Args: { p_document_id: string };
        Returns: string | null;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

export type DocumentRow = Database["public"]["Tables"]["documents"]["Row"];
