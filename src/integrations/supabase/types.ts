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
      clip_analysis: {
        Row: {
          analyzed_at: string | null
          created_at: string
          description: string | null
          error: string | null
          frames: Json | null
          id: string
          job_id: string
          lease: string | null
          lease_until: string | null
          next_attempt_at: string
          output_path: string
          request_id: string | null
          state: string
          user_id: string
          words: Json | null
        }
        Insert: {
          analyzed_at?: string | null
          created_at?: string
          description?: string | null
          error?: string | null
          frames?: Json | null
          id?: string
          job_id: string
          lease?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          output_path: string
          request_id?: string | null
          state?: string
          user_id: string
          words?: Json | null
        }
        Update: {
          analyzed_at?: string | null
          created_at?: string
          description?: string | null
          error?: string | null
          frames?: Json | null
          id?: string
          job_id?: string
          lease?: string | null
          lease_until?: string | null
          next_attempt_at?: string
          output_path?: string
          request_id?: string | null
          state?: string
          user_id?: string
          words?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "clip_analysis_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
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
      live_highlights: {
        Row: {
          attempts: number
          chatters: number
          claim: string | null
          claim_until: string | null
          created_at: string
          detail: string | null
          emotes: number
          end_at: string
          id: string
          job_id: string | null
          monitor_id: string
          offset_s: number | null
          output_path: string | null
          peak_at: string
          reason: string | null
          score: number
          start_at: string
          status: string
          trigger: string
          updated_at: string
          user_id: string
        }
        Insert: {
          attempts?: number
          chatters: number
          claim?: string | null
          claim_until?: string | null
          created_at?: string
          detail?: string | null
          emotes: number
          end_at: string
          id?: string
          job_id?: string | null
          monitor_id: string
          offset_s?: number | null
          output_path?: string | null
          peak_at: string
          reason?: string | null
          score: number
          start_at: string
          status?: string
          trigger?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          attempts?: number
          chatters?: number
          claim?: string | null
          claim_until?: string | null
          created_at?: string
          detail?: string | null
          emotes?: number
          end_at?: string
          id?: string
          job_id?: string | null
          monitor_id?: string
          offset_s?: number | null
          output_path?: string | null
          peak_at?: string
          reason?: string | null
          score?: number
          start_at?: string
          status?: string
          trigger?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_highlights_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "live_monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      live_monitors: {
        Row: {
          archived_at: string | null
          channel_id: string | null
          channel_title: string | null
          created_at: string
          enabled: boolean
          event_state: Json
          id: string
          input: string
          last_poll_at: string | null
          lease: string | null
          lease_until: string | null
          live_chat_id: string | null
          live_video_id: string | null
          media_mode: string
          messages_seen: number
          next_poll_at: string
          observation: string
          observation_error: string | null
          observed_at: string | null
          page_token: string | null
          platform: string
          poll_failures: number
          recorder_state: Json | null
          recording_url: string | null
          rights_confirmed: boolean
          stats: Json
          status: string
          status_detail: string | null
          stopped_at: string | null
          stream_started_at: string | null
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          channel_id?: string | null
          channel_title?: string | null
          created_at?: string
          enabled?: boolean
          event_state?: Json
          id?: string
          input: string
          last_poll_at?: string | null
          lease?: string | null
          lease_until?: string | null
          live_chat_id?: string | null
          live_video_id?: string | null
          media_mode?: string
          messages_seen?: number
          next_poll_at?: string
          observation?: string
          observation_error?: string | null
          observed_at?: string | null
          page_token?: string | null
          platform: string
          poll_failures?: number
          recorder_state?: Json | null
          recording_url?: string | null
          rights_confirmed?: boolean
          stats?: Json
          status?: string
          status_detail?: string | null
          stopped_at?: string | null
          stream_started_at?: string | null
          user_id: string
        }
        Update: {
          archived_at?: string | null
          channel_id?: string | null
          channel_title?: string | null
          created_at?: string
          enabled?: boolean
          event_state?: Json
          id?: string
          input?: string
          last_poll_at?: string | null
          lease?: string | null
          lease_until?: string | null
          live_chat_id?: string | null
          live_video_id?: string | null
          media_mode?: string
          messages_seen?: number
          next_poll_at?: string
          observation?: string
          observation_error?: string | null
          observed_at?: string | null
          page_token?: string | null
          platform?: string
          poll_failures?: number
          recorder_state?: Json | null
          recording_url?: string | null
          rights_confirmed?: boolean
          stats?: Json
          status?: string
          status_detail?: string | null
          stopped_at?: string | null
          stream_started_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      live_scene_checks: {
        Row: {
          activity: string
          confidence: number | null
          created_at: string
          frame_at: string
          game: string | null
          id: string
          monitor_id: string
          note: string | null
          switched_from: string | null
          user_id: string
        }
        Insert: {
          activity: string
          confidence?: number | null
          created_at?: string
          frame_at: string
          game?: string | null
          id?: string
          monitor_id: string
          note?: string | null
          switched_from?: string | null
          user_id: string
        }
        Update: {
          activity?: string
          confidence?: number | null
          created_at?: string
          frame_at?: string
          game?: string | null
          id?: string
          monitor_id?: string
          note?: string | null
          switched_from?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_scene_checks_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "live_monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      live_streams: {
        Row: {
          ended_at: string | null
          id: string
          last_observed_at: string
          monitor_id: string
          started_at: string
          stream_key: string
          user_id: string
        }
        Insert: {
          ended_at?: string | null
          id?: string
          last_observed_at: string
          monitor_id: string
          started_at: string
          stream_key: string
          user_id: string
        }
        Update: {
          ended_at?: string | null
          id?: string
          last_observed_at?: string
          monitor_id?: string
          started_at?: string
          stream_key?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "live_streams_monitor_id_fkey"
            columns: ["monitor_id"]
            isOneToOne: false
            referencedRelation: "live_monitors"
            referencedColumns: ["id"]
          },
        ]
      }
      live_workers: {
        Row: {
          created_at: string
          id: string
          label: string
          last_seen_at: string | null
          token_hash: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string
          last_seen_at?: string | null
          token_hash: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string
          last_seen_at?: string | null
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      local_candidates: {
        Row: {
          caption_note: string | null
          captions: Json | null
          channel: string
          created_at: string
          detail: string | null
          id: string
          job_id: string | null
          output_path: string | null
          reason: string | null
          review: string | null
          score: number | null
          segments: Json
          status: string
          updated_at: string
          user_id: string
          whisper_request: string | null
          window_info: Json
        }
        Insert: {
          caption_note?: string | null
          captions?: Json | null
          channel: string
          created_at?: string
          detail?: string | null
          id?: string
          job_id?: string | null
          output_path?: string | null
          reason?: string | null
          review?: string | null
          score?: number | null
          segments: Json
          status: string
          updated_at?: string
          user_id: string
          whisper_request?: string | null
          window_info?: Json
        }
        Update: {
          caption_note?: string | null
          captions?: Json | null
          channel?: string
          created_at?: string
          detail?: string | null
          id?: string
          job_id?: string | null
          output_path?: string | null
          reason?: string | null
          review?: string | null
          score?: number | null
          segments?: Json
          status?: string
          updated_at?: string
          user_id?: string
          whisper_request?: string | null
          window_info?: Json
        }
        Relationships: []
      }
      local_footage: {
        Row: {
          aligned: boolean
          channel: string
          detail: string | null
          duration_s: number | null
          file_name: string
          id: string
          rel_path: string
          session: string
          size_bytes: number | null
          start_at: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          aligned?: boolean
          channel: string
          detail?: string | null
          duration_s?: number | null
          file_name: string
          id?: string
          rel_path: string
          session: string
          size_bytes?: number | null
          start_at?: string | null
          status: string
          updated_at?: string
          user_id: string
        }
        Update: {
          aligned?: boolean
          channel?: string
          detail?: string | null
          duration_s?: number | null
          file_name?: string
          id?: string
          rel_path?: string
          session?: string
          size_bytes?: number | null
          start_at?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      phil_app_commands: {
        Row: {
          created_at: string
          id: string
          operation: string
          owner_id: string
          payload: Json
          request_key: string
          result: Json | null
          state: string
        }
        Insert: {
          created_at?: string
          id?: string
          operation: string
          owner_id: string
          payload: Json
          request_key: string
          result?: Json | null
          state?: string
        }
        Update: {
          created_at?: string
          id?: string
          operation?: string
          owner_id?: string
          payload?: Json
          request_key?: string
          result?: Json | null
          state?: string
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
      recorder_controls: {
        Row: {
          paused: boolean
          updated_at: string
          user_id: string
        }
        Insert: {
          paused?: boolean
          updated_at?: string
          user_id: string
        }
        Update: {
          paused?: boolean
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
      vps_agents: {
        Row: {
          agent_version: string | null
          id: string
          info: Json
          last_seen_at: string | null
          last_server_ts: string | null
          name: string
          paired_at: string
          revoked_at: string | null
          services: Json
          token_hash: string
          user_id: string
        }
        Insert: {
          agent_version?: string | null
          id?: string
          info?: Json
          last_seen_at?: string | null
          last_server_ts?: string | null
          name?: string
          paired_at?: string
          revoked_at?: string | null
          services?: Json
          token_hash: string
          user_id: string
        }
        Update: {
          agent_version?: string | null
          id?: string
          info?: Json
          last_seen_at?: string | null
          last_server_ts?: string | null
          name?: string
          paired_at?: string
          revoked_at?: string | null
          services?: Json
          token_hash?: string
          user_id?: string
        }
        Relationships: []
      }
      vps_commands: {
        Row: {
          agent_id: string
          args: Json
          created_at: string
          done_at: string | null
          error: string | null
          id: string
          idem_key: string
          op: string
          result: Json | null
          sent_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          agent_id: string
          args?: Json
          created_at?: string
          done_at?: string | null
          error?: string | null
          id?: string
          idem_key: string
          op: string
          result?: Json | null
          sent_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          args?: Json
          created_at?: string
          done_at?: string | null
          error?: string | null
          id?: string
          idem_key?: string
          op?: string
          result?: Json | null
          sent_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vps_commands_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "vps_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      vps_mirror: {
        Row: {
          agent_id: string
          data: Json
          kind: string
          row_key: string
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id: string
          data: Json
          kind: string
          row_key: string
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string
          data?: Json
          kind?: string
          row_key?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vps_mirror_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "vps_agents"
            referencedColumns: ["id"]
          },
        ]
      }
      vps_pairings: {
        Row: {
          code_hash: string
          created_at: string
          expires_at: string
          id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          code_hash: string
          created_at?: string
          expires_at: string
          id?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          code_hash?: string
          created_at?: string
          expires_at?: string
          id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      phil_claim_command: {
        Args: never
        Returns: {
          id: string
          operation: string
          payload: Json
        }[]
      }
      phil_finish_command: {
        Args: { command_id: string; outcome: Json; success: boolean }
        Returns: undefined
      }
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
