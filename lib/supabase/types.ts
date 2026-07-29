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
          clone_lease_token: string | null;
          clone_lease_expires_at: string | null;
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
          clone_lease_token?: string | null;
          clone_lease_expires_at?: string | null;
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
          clone_lease_token?: string | null;
          clone_lease_expires_at?: string | null;
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
          id: string;
          document_id: string;
          owner: string;
          attempt_count: number;
          next_attempt_at: string;
          lease_token: string | null;
          lease_expires_at: string | null;
          last_error: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          owner: string;
          attempt_count?: number;
          next_attempt_at?: string;
          lease_token?: string | null;
          lease_expires_at?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          document_id?: string;
          owner?: string;
          attempt_count?: number;
          next_attempt_at?: string;
          lease_token?: string | null;
          lease_expires_at?: string | null;
          last_error?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      document_media_backfill_snapshots: {
        Row: {
          id: string;
          document_id: string;
          owner: string;
          original_content: string;
          original_updated_at: string;
          copied_paths: Json;
          created_at: string;
          expires_at: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          owner: string;
          original_content: string;
          original_updated_at: string;
          copied_paths?: Json;
          created_at?: string;
          expires_at?: string;
        };
        Update: {
          id?: string;
          document_id?: string;
          owner?: string;
          original_content?: string;
          original_updated_at?: string;
          copied_paths?: Json;
          created_at?: string;
          expires_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      claim_document_media_cleanup_jobs: {
        Args: {
          p_limit?: number;
          p_lease_seconds?: number;
        };
        Returns: {
          job_id: string;
          document_id: string;
          owner: string;
          attempt_count: number;
          lease_token: string;
          created_at: string;
        }[];
      };
      claim_expired_document_clones: {
        Args: {
          p_limit?: number;
          p_lease_seconds?: number;
        };
        Returns: {
          document_id: string;
          owner: string;
          lease_token: string;
        }[];
      };
      get_document_media_rollout_state: {
        Args: Record<PropertyKey, never>;
        Returns: {
          phase: string;
          supabase_origin: string | null;
        }[];
      };
      set_document_media_rollout_state: {
        Args: {
          p_phase: string;
          p_supabase_origin?: string | null;
        };
        Returns: {
          phase: string;
          supabase_origin: string | null;
        }[];
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
