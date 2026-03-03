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
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
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
