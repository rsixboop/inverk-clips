export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      job_events: {
        Row: {
          created_at: string
          duration_ms: number | null
          id: number
          job_id: string
          level: string
          message: string
          stage: string
          user_id: string
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          id?: number
          job_id: string
          level?: string
          message: string
          stage: string
          user_id?: string
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          id?: number
          job_id?: string
          level?: string
          message?: string
          stage?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          approve_sources: boolean
          attempts: number
          audio_mode: string
          caption: string | null
          created_at: string
          deadline_at: string
          error: string | null
          failed_stage: string | null
          finished_at: string | null
          id: string
          idempotency_key: string
          language: string
          lease_token: string | null
          lock_until: string | null
          mode: string
          next_attempt_at: string
          niche_id: string | null
          output_bytes: number | null
          output_mime: string | null
          output_path: string | null
          output_url_expires: string | null
          plan: Json | null
          prompt: string
          provider_project_id: string | null
          render_attempt: number
          render_id: string | null
          review_before_render: boolean
          route: string
          script: string | null
          source_id: string | null
          stage: string
          status: string
          submit_state: string | null
          target_seconds: number
          updated_at: string
          user_id: string
          workflow_version: number
        }
        Insert: {
          approve_sources?: boolean
          attempts?: number
          audio_mode?: string
          caption?: string | null
          created_at?: string
          deadline_at?: string
          error?: string | null
          failed_stage?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key: string
          language?: string
          lease_token?: string | null
          lock_until?: string | null
          mode: string
          next_attempt_at?: string
          niche_id?: string | null
          output_bytes?: number | null
          output_mime?: string | null
          output_path?: string | null
          output_url_expires?: string | null
          plan?: Json | null
          prompt?: string
          provider_project_id?: string | null
          render_attempt?: number
          render_id?: string | null
          review_before_render?: boolean
          route?: string
          script?: string | null
          source_id?: string | null
          stage?: string
          status?: string
          submit_state?: string | null
          target_seconds?: number
          updated_at?: string
          user_id?: string
          workflow_version?: number
        }
        Update: {
          approve_sources?: boolean
          attempts?: number
          audio_mode?: string
          caption?: string | null
          created_at?: string
          deadline_at?: string
          error?: string | null
          failed_stage?: string | null
          finished_at?: string | null
          id?: string
          idempotency_key?: string
          language?: string
          lease_token?: string | null
          lock_until?: string | null
          mode?: string
          next_attempt_at?: string
          niche_id?: string | null
          output_bytes?: number | null
          output_mime?: string | null
          output_path?: string | null
          output_url_expires?: string | null
          plan?: Json | null
          prompt?: string
          provider_project_id?: string | null
          render_attempt?: number
          render_id?: string | null
          review_before_render?: boolean
          route?: string
          script?: string | null
          source_id?: string | null
          stage?: string
          status?: string
          submit_state?: string | null
          target_seconds?: number
          updated_at?: string
          user_id?: string
          workflow_version?: number
        }
        Relationships: [
          {
            foreignKeyName: "jobs_niche_id_fkey"
            columns: ["niche_id"]
            isOneToOne: false
            referencedRelation: "niches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_source_id_fkey"
            columns: ["source_id"]
            isOneToOne: false
            referencedRelation: "sources"
            referencedColumns: ["id"]
          },
        ]
      }
      news_overlay_assets: {
        Row: {
          asset_key: string
          batch_key: string
          claim: string | null
          phase: string
          state: Json
          user_id: string
        }
        Insert: {
          asset_key: string
          batch_key: string
          claim?: string | null
          phase?: string
          state?: Json
          user_id: string
        }
        Update: {
          asset_key?: string
          batch_key?: string
          claim?: string | null
          phase?: string
          state?: Json
          user_id?: string
        }
        Relationships: []
      }
      news_overlay_batches: {
        Row: {
          cache_key: string
          reserved_usd: number
          user_id: string
        }
        Insert: {
          cache_key: string
          reserved_usd?: number
          user_id: string
        }
        Update: {
          cache_key?: string
          reserved_usd?: number
          user_id?: string
        }
        Relationships: []
      }
      niches: {
        Row: {
          created_at: string
          default_language: string
          description: string
          id: string
          name: string
          user_id: string
        }
        Insert: {
          created_at?: string
          default_language?: string
          description?: string
          id?: string
          name: string
          user_id?: string
        }
        Update: {
          created_at?: string
          default_language?: string
          description?: string
          id?: string
          name?: string
          user_id?: string
        }
        Relationships: []
      }
      posting_queue: {
        Row: {
          account_id: string | null
          created_at: string
          id: string
          job_id: string
          status: string
          user_id: string
        }
        Insert: {
          account_id?: string | null
          created_at?: string
          id?: string
          job_id: string
          status?: string
          user_id?: string
        }
        Update: {
          account_id?: string | null
          created_at?: string
          id?: string
          job_id?: string
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "posting_queue_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "social_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posting_queue_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_configs: {
        Row: {
          id: string
          provider: string
          settings: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          id?: string
          provider: string
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Update: {
          id?: string
          provider?: string
          settings?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      social_accounts: {
        Row: {
          created_at: string
          handle: string
          id: string
          platform: string
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          handle?: string
          id?: string
          platform?: string
          status?: string
          user_id?: string
        }
        Update: {
          created_at?: string
          handle?: string
          id?: string
          platform?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      sources: {
        Row: {
          attribution: string
          bytes: number | null
          created_at: string
          duration_s: number | null
          external_id: string | null
          id: string
          kind: string
          license: string
          mime: string | null
          permission: string
          permission_note: string
          preview_url: string | null
          provider: string
          status: string
          status_note: string
          storage_path: string | null
          title: string
          url: string | null
          user_id: string
        }
        Insert: {
          attribution?: string
          bytes?: number | null
          created_at?: string
          duration_s?: number | null
          external_id?: string | null
          id?: string
          kind: string
          license?: string
          mime?: string | null
          permission?: string
          permission_note?: string
          preview_url?: string | null
          provider?: string
          status?: string
          status_note?: string
          storage_path?: string | null
          title?: string
          url?: string | null
          user_id?: string
        }
        Update: {
          attribution?: string
          bytes?: number | null
          created_at?: string
          duration_s?: number | null
          external_id?: string | null
          id?: string
          kind?: string
          license?: string
          mime?: string | null
          permission?: string
          permission_note?: string
          preview_url?: string | null
          provider?: string
          status?: string
          status_note?: string
          storage_path?: string | null
          title?: string
          url?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      reserve_news_overlay: {
        Args: {
          p_asset: string
          p_batch: string
          p_cost: number
          p_state: Json
          p_user: string
        }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
