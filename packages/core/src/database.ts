// Fichier généré par scripts/gen-db-types.mjs à partir des migrations. Ne pas modifier.
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      app_config: {
        Row: {
          id: boolean;
          visibility: string;
          admin_mfa_required: boolean;
          site_url: string | null;
          yahoo_symbol: string;
          euronext_code: string;
          euronext_history_url: string | null;
          alert_spread_bps: number;
          updated_at: string;
        };
        Insert: {
          id?: boolean;
          visibility?: string;
          admin_mfa_required?: boolean;
          site_url?: string | null;
          yahoo_symbol?: string;
          euronext_code?: string;
          euronext_history_url?: string | null;
          alert_spread_bps?: number;
          updated_at?: string;
        };
        Update: {
          id?: boolean;
          visibility?: string;
          admin_mfa_required?: boolean;
          site_url?: string | null;
          yahoo_symbol?: string;
          euronext_code?: string;
          euronext_history_url?: string | null;
          alert_spread_bps?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: number;
          at: string;
          table_name: string;
          row_key: string | null;
          action: string;
          old: Json | null;
          new: Json | null;
          user_id: string | null;
        };
        Insert: {
          id?: number;
          at?: string;
          table_name: string;
          row_key?: string | null;
          action: string;
          old?: Json | null;
          new?: Json | null;
          user_id?: string | null;
        };
        Update: {
          id?: number;
          at?: string;
          table_name?: string;
          row_key?: string | null;
          action?: string;
          old?: Json | null;
          new?: Json | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      backtests: {
        Row: {
          id: number;
          run_at: string;
          kind: string;
          params: Json;
          summary: Json;
          results: Json;
          exact_rate: number | null;
          mae: number | null;
          coverage: number | null;
          run_by: string | null;
        };
        Insert: {
          id?: number;
          run_at?: string;
          kind: string;
          params?: Json;
          summary?: Json;
          results?: Json;
          exact_rate?: number | null;
          mae?: number | null;
          coverage?: number | null;
          run_by?: string | null;
        };
        Update: {
          id?: number;
          run_at?: string;
          kind?: string;
          params?: Json;
          summary?: Json;
          results?: Json;
          exact_rate?: number | null;
          mae?: number | null;
          coverage?: number | null;
          run_by?: string | null;
        };
        Relationships: [];
      };
      calc_params: {
        Row: {
          id: number;
          valid_from: string;
          label: string;
          window_days: number;
          discount_bps: number;
          price_field: string;
          rounding: string;
          exclude_board_day: boolean;
          tolerance_bps: number;
          n_sims: number;
          bootstrap_days: number;
          model_sigma_bps: number;
          active: boolean;
          note: string | null;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          valid_from?: string;
          label: string;
          window_days?: number;
          discount_bps?: number;
          price_field?: string;
          rounding?: string;
          exclude_board_day?: boolean;
          tolerance_bps?: number;
          n_sims?: number;
          bootstrap_days?: number;
          model_sigma_bps?: number;
          active?: boolean;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          id?: number;
          valid_from?: string;
          label?: string;
          window_days?: number;
          discount_bps?: number;
          price_field?: string;
          rounding?: string;
          exclude_board_day?: boolean;
          tolerance_bps?: number;
          n_sims?: number;
          bootstrap_days?: number;
          model_sigma_bps?: number;
          active?: boolean;
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
      dividends: {
        Row: {
          ex_date: string;
          amount: number;
          kind: string;
          pay_date: string | null;
          source: string | null;
          note: string | null;
        };
        Insert: {
          ex_date: string;
          amount: number;
          kind?: string;
          pay_date?: string | null;
          source?: string | null;
          note?: string | null;
        };
        Update: {
          ex_date?: string;
          amount?: number;
          kind?: string;
          pay_date?: string | null;
          source?: string | null;
          note?: string | null;
        };
        Relationships: [];
      };
      estimates: {
        Row: {
          id: number;
          quadrimester_code: string;
          kind: string;
          computed_at: string;
          as_of: string;
          last_price: number | null;
          last_price_date: string | null;
          params_id: number | null;
          seed: number | null;
          n_sims: number;
          state: string;
          central: number;
          p05: number;
          p25: number;
          p75: number;
          p95: number;
          reliability: number;
          prob_below: number | null;
          reference_price: number | null;
          known_sessions: number | null;
          known_min: number | null;
          known_max: number | null;
          most_probable_date: string | null;
          window_start: string | null;
          window_end: string | null;
          board: Json | null;
          details: Json;
        };
        Insert: {
          id?: number;
          quadrimester_code: string;
          kind?: string;
          computed_at?: string;
          as_of: string;
          last_price?: number | null;
          last_price_date?: string | null;
          params_id?: number | null;
          seed?: number | null;
          n_sims?: number;
          state: string;
          central: number;
          p05: number;
          p25: number;
          p75: number;
          p95: number;
          reliability: number;
          prob_below?: number | null;
          reference_price?: number | null;
          known_sessions?: number | null;
          known_min?: number | null;
          known_max?: number | null;
          most_probable_date?: string | null;
          window_start?: string | null;
          window_end?: string | null;
          board?: Json | null;
          details?: Json;
        };
        Update: {
          id?: number;
          quadrimester_code?: string;
          kind?: string;
          computed_at?: string;
          as_of?: string;
          last_price?: number | null;
          last_price_date?: string | null;
          params_id?: number | null;
          seed?: number | null;
          n_sims?: number;
          state?: string;
          central?: number;
          p05?: number;
          p25?: number;
          p75?: number;
          p95?: number;
          reliability?: number;
          prob_below?: number | null;
          reference_price?: number | null;
          known_sessions?: number | null;
          known_min?: number | null;
          known_max?: number | null;
          most_probable_date?: string | null;
          window_start?: string | null;
          window_end?: string | null;
          board?: Json | null;
          details?: Json;
        };
        Relationships: [];
      };
      job_runs: {
        Row: {
          id: number;
          job: string;
          trigger: string;
          requested_by: string | null;
          started_at: string;
          finished_at: string | null;
          status: string;
          message: string | null;
          details: Json | null;
        };
        Insert: {
          id?: number;
          job: string;
          trigger?: string;
          requested_by?: string | null;
          started_at?: string;
          finished_at?: string | null;
          status?: string;
          message?: string | null;
          details?: Json | null;
        };
        Update: {
          id?: number;
          job?: string;
          trigger?: string;
          requested_by?: string | null;
          started_at?: string;
          finished_at?: string | null;
          status?: string;
          message?: string | null;
          details?: Json | null;
        };
        Relationships: [];
      };
      market_holidays: {
        Row: {
          day: string;
          label: string;
          half_day: boolean;
          source: string;
        };
        Insert: {
          day: string;
          label: string;
          half_day?: boolean;
          source?: string;
        };
        Update: {
          day?: string;
          label?: string;
          half_day?: boolean;
          source?: string;
        };
        Relationships: [];
      };
      quadrimesters: {
        Row: {
          code: string;
          start_date: string;
          end_date: string;
          payment_close_date: string;
          board_date: string | null;
          board_slot_start: string | null;
          board_slot_end: string | null;
          board_weights: Json | null;
          board_status: string;
          board_source: string | null;
          official_price: number | null;
          official_published_at: string | null;
          notice_url: string | null;
          computed_price: number | null;
          computed_missing: number | null;
          computed_at: string | null;
          final_estimate_id: number | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          code: string;
          start_date: string;
          end_date: string;
          payment_close_date: string;
          board_date?: string | null;
          board_slot_start?: string | null;
          board_slot_end?: string | null;
          board_weights?: Json | null;
          board_status?: string;
          board_source?: string | null;
          official_price?: number | null;
          official_published_at?: string | null;
          notice_url?: string | null;
          computed_price?: number | null;
          computed_missing?: number | null;
          computed_at?: string | null;
          final_estimate_id?: number | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          code?: string;
          start_date?: string;
          end_date?: string;
          payment_close_date?: string;
          board_date?: string | null;
          board_slot_start?: string | null;
          board_slot_end?: string | null;
          board_weights?: Json | null;
          board_status?: string;
          board_source?: string | null;
          official_price?: number | null;
          official_published_at?: string | null;
          notice_url?: string | null;
          computed_price?: number | null;
          computed_missing?: number | null;
          computed_at?: string | null;
          final_estimate_id?: number | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      quote_live: {
        Row: {
          id: boolean;
          price: number;
          prev_close: number | null;
          change_pct: number | null;
          day_open: number | null;
          quote_time: string;
          source: string;
          fetched_at: string;
        };
        Insert: {
          id?: boolean;
          price: number;
          prev_close?: number | null;
          change_pct?: number | null;
          day_open?: number | null;
          quote_time: string;
          source: string;
          fetched_at?: string;
        };
        Update: {
          id?: boolean;
          price?: number;
          prev_close?: number | null;
          change_pct?: number | null;
          day_open?: number | null;
          quote_time?: string;
          source?: string;
          fetched_at?: string;
        };
        Relationships: [];
      };
      stock_prices: {
        Row: {
          trade_date: string;
          open: number | null;
          high: number | null;
          low: number | null;
          close: number | null;
          vwap: number | null;
          volume: number | null;
          source: string;
          fetched_at: string;
          check_open: number | null;
          check_close: number | null;
          check_source: string | null;
          check_at: string | null;
          is_manual: boolean;
          manual_reason: string | null;
          updated_by: string | null;
        };
        Insert: {
          trade_date: string;
          open?: number | null;
          high?: number | null;
          low?: number | null;
          close?: number | null;
          vwap?: number | null;
          volume?: number | null;
          source?: string;
          fetched_at?: string;
          check_open?: number | null;
          check_close?: number | null;
          check_source?: string | null;
          check_at?: string | null;
          is_manual?: boolean;
          manual_reason?: string | null;
          updated_by?: string | null;
        };
        Update: {
          trade_date?: string;
          open?: number | null;
          high?: number | null;
          low?: number | null;
          close?: number | null;
          vwap?: number | null;
          volume?: number | null;
          source?: string;
          fetched_at?: string;
          check_open?: number | null;
          check_close?: number | null;
          check_source?: string | null;
          check_at?: string | null;
          is_manual?: boolean;
          manual_reason?: string | null;
          updated_by?: string | null;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          user_id: string;
          role: string;
          invited_by: string | null;
          created_at: string;
        };
        Insert: {
          user_id: string;
          role: string;
          invited_by?: string | null;
          created_at?: string;
        };
        Update: {
          user_id?: string;
          role?: string;
          invited_by?: string | null;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      v_dashboard: {
        Row: {
          today: string | null;
          current_code: string | null;
          current_start: string | null;
          current_end: string | null;
          current_payment_close: string | null;
          current_price: number | null;
          next_code: string | null;
          next_start: string | null;
          next_end: string | null;
          next_payment_close: string | null;
          board_date: string | null;
          board_slot_start: string | null;
          board_slot_end: string | null;
          board_weights: Json | null;
          board_status: string | null;
          board_source: string | null;
          estimate_id: number | null;
          estimate_kind: string | null;
          computed_at: string | null;
          as_of: string | null;
          state: string | null;
          central: number | null;
          p05: number | null;
          p25: number | null;
          p75: number | null;
          p95: number | null;
          reliability: number | null;
          prob_below: number | null;
          reference_price: number | null;
          known_sessions: number | null;
          known_min: number | null;
          known_max: number | null;
          most_probable_date: string | null;
          window_start: string | null;
          window_end: string | null;
          estimate_last_price: number | null;
          n_sims: number | null;
          seed: number | null;
          details: Json | null;
          quote_price: number | null;
          quote_prev_close: number | null;
          quote_change_pct: number | null;
          quote_day_open: number | null;
          quote_time: string | null;
          quote_source: string | null;
          last_session: string | null;
          last_open: number | null;
          last_close: number | null;
        };
        Relationships: [];
      };
      v_estimate_history: {
        Row: {
          quadrimester_code: string | null;
          day: string | null;
          computed_at: string | null;
          as_of: string | null;
          state: string | null;
          central: number | null;
          p05: number | null;
          p25: number | null;
          p75: number | null;
          p95: number | null;
          reliability: number | null;
          known_sessions: number | null;
          prob_below: number | null;
        };
        Relationships: [];
      };
      v_history: {
        Row: {
          code: string | null;
          start_date: string | null;
          end_date: string | null;
          payment_close_date: string | null;
          board_date: string | null;
          board_slot_start: string | null;
          board_slot_end: string | null;
          board_status: string | null;
          board_source: string | null;
          official_price: number | null;
          official_published_at: string | null;
          notice_url: string | null;
          computed_price: number | null;
          computed_missing: number | null;
          computed_diff: number | null;
          estimate_id: number | null;
          estimate_kind: string | null;
          estimate_as_of: string | null;
          estimate_central: number | null;
          estimate_p05: number | null;
          estimate_p95: number | null;
          estimate_reliability: number | null;
          estimate_state: string | null;
          estimate_diff: number | null;
          estimate_diff_pct: number | null;
          quote_price: number | null;
          gain_pct: number | null;
        };
        Relationships: [];
      };
      v_job_status: {
        Row: {
          job: string | null;
          started_at: string | null;
          finished_at: string | null;
          status: string | null;
          message: string | null;
          duration_ms: number | null;
          recent_errors: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      activate_calc_params: {
        Args: { p_id: number };
        Returns: undefined;
      };
      admin_import_prices: {
        Args: { p_rows: Json; p_reason: string; p_overwrite?: boolean };
        Returns: Json;
      };
      admin_set_official_price: {
        Args: { p_code: string; p_price: number; p_published?: string; p_notice_url?: string };
        Returns: number;
      };
      can_read: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      castor_call: {
        Args: { p_task: string; p_body?: Json };
        Returns: number;
      };
      castor_register_endpoint: {
        Args: { p_url: string };
        Returns: string;
      };
      castor_secret: {
        Args: { p_name: string };
        Returns: string;
      };
      castor_set_secret: {
        Args: { p_name: string; p_value: string };
        Returns: undefined;
      };
      castor_setup_cron: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      castor_unschedule_cron: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      castor_verify_cron_secret: {
        Args: { p_secret: string };
        Returns: boolean;
      };
      has_role: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      is_admin: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      is_public_site: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      my_access: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      paris_today: {
        Args: Record<PropertyKey, never>;
        Returns: string;
      };
      price_series: {
        Args: { p_from?: string; p_to?: string };
        Returns: Json;
      };
      upsert_prices: {
        Args: { p_rows: Json; p_source: string; p_mode?: string };
        Returns: Json;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
