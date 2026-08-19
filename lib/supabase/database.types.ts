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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      aircraft_types: {
        Row: {
          active: boolean
          code: string
          label: string
        }
        Insert: {
          active?: boolean
          code: string
          label: string
        }
        Update: {
          active?: boolean
          code?: string
          label?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          device_info: string | null
          id: string
          ip_address: unknown
          new_values: Json | null
          old_values: Json | null
          performed_at: string
          performed_by: string
          performed_by_id: string | null
          transaction_id: string | null
        }
        Insert: {
          action: string
          device_info?: string | null
          id?: string
          ip_address?: unknown
          new_values?: Json | null
          old_values?: Json | null
          performed_at?: string
          performed_by: string
          performed_by_id?: string | null
          transaction_id?: string | null
        }
        Update: {
          action?: string
          device_info?: string | null
          id?: string
          ip_address?: unknown
          new_values?: Json | null
          old_values?: Json | null
          performed_at?: string
          performed_by?: string
          performed_by_id?: string | null
          transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      bay_board: {
        Row: {
          aircraft_type: string | null
          bay: string
          cleared_at: string | null
          cleared_by_report_id: string | null
          created_at: string
          created_by: string
          id: string
          on_ground_since: string
          reg_no: string
          station: string
        }
        Insert: {
          aircraft_type?: string | null
          bay: string
          cleared_at?: string | null
          cleared_by_report_id?: string | null
          created_at?: string
          created_by: string
          id?: string
          on_ground_since: string
          reg_no: string
          station: string
        }
        Update: {
          aircraft_type?: string | null
          bay?: string
          cleared_at?: string | null
          cleared_by_report_id?: string | null
          created_at?: string
          created_by?: string
          id?: string
          on_ground_since?: string
          reg_no?: string
          station?: string
        }
        Relationships: [
          {
            foreignKeyName: "bay_board_cleared_by_report_id_fkey"
            columns: ["cleared_by_report_id"]
            isOneToOne: false
            referencedRelation: "report_sec029"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bay_board_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bay_board_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      catering_companies: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          name: string
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
        }
        Relationships: []
      }
      cscs_settings: {
        Row: {
          key: string
          value: string
        }
        Insert: {
          key: string
          value: string
        }
        Update: {
          key?: string
          value?: string
        }
        Relationships: []
      }
      drivers: {
        Row: {
          airport_pass_number: string | null
          catering_company_id: string | null
          created_at: string
          id: string
          is_active: boolean
          name: string
          pass_expiry_date: string | null
          staff_ic_number: string | null
          staff_id: string
          swap_to_staff_ic: boolean
        }
        Insert: {
          airport_pass_number?: string | null
          catering_company_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          pass_expiry_date?: string | null
          staff_ic_number?: string | null
          staff_id: string
          swap_to_staff_ic?: boolean
        }
        Update: {
          airport_pass_number?: string | null
          catering_company_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          pass_expiry_date?: string | null
          staff_ic_number?: string | null
          staff_id?: string
          swap_to_staff_ic?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "drivers_catering_company_id_fkey"
            columns: ["catering_company_id"]
            isOneToOne: false
            referencedRelation: "catering_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      duty_audit_log: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          entity: string
          entity_id: string | null
          id: number
          payload: Json | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          entity: string
          entity_id?: string | null
          id?: never
          payload?: Json | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          entity?: string
          entity_id?: string | null
          id?: never
          payload?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "duty_audit_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      duty_records: {
        Row: {
          check_in_accuracy_m: number | null
          check_in_at: string | null
          check_in_hmac: string | null
          check_in_inside_fence: boolean | null
          check_in_lat: number | null
          check_in_lng: number | null
          check_in_offline: boolean
          check_out_at: string | null
          check_out_inside_fence: boolean | null
          check_out_lat: number | null
          check_out_lng: number | null
          created_at: string
          duty_date: string
          early_out_minutes: number
          early_out_remark: string | null
          handover_notes: string | null
          id: string
          is_missing_checkout: boolean
          is_off_schedule: boolean
          late_minutes: number
          late_remark: string | null
          post_assignment: string | null
          profile_id: string
          shift_code: string
          station: string
          status: string
          team: string | null
          total_minutes: number | null
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          check_in_accuracy_m?: number | null
          check_in_at?: string | null
          check_in_hmac?: string | null
          check_in_inside_fence?: boolean | null
          check_in_lat?: number | null
          check_in_lng?: number | null
          check_in_offline?: boolean
          check_out_at?: string | null
          check_out_inside_fence?: boolean | null
          check_out_lat?: number | null
          check_out_lng?: number | null
          created_at?: string
          duty_date: string
          early_out_minutes?: number
          early_out_remark?: string | null
          handover_notes?: string | null
          id?: string
          is_missing_checkout?: boolean
          is_off_schedule?: boolean
          late_minutes?: number
          late_remark?: string | null
          post_assignment?: string | null
          profile_id: string
          shift_code: string
          station: string
          status?: string
          team?: string | null
          total_minutes?: number | null
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          check_in_accuracy_m?: number | null
          check_in_at?: string | null
          check_in_hmac?: string | null
          check_in_inside_fence?: boolean | null
          check_in_lat?: number | null
          check_in_lng?: number | null
          check_in_offline?: boolean
          check_out_at?: string | null
          check_out_inside_fence?: boolean | null
          check_out_lat?: number | null
          check_out_lng?: number | null
          created_at?: string
          duty_date?: string
          early_out_minutes?: number
          early_out_remark?: string | null
          handover_notes?: string | null
          id?: string
          is_missing_checkout?: boolean
          is_off_schedule?: boolean
          late_minutes?: number
          late_remark?: string | null
          post_assignment?: string | null
          profile_id?: string
          shift_code?: string
          station?: string
          status?: string
          team?: string | null
          total_minutes?: number | null
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "duty_records_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duty_records_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "duty_records_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "duty_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      duty_zones: {
        Row: {
          active: boolean
          center_lat: number
          center_lng: number
          code: string
          created_at: string
          created_by: string | null
          id: string
          name: string
          polygon: Json
          radius_m: number
          station: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          center_lat: number
          center_lng: number
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          polygon: Json
          radius_m?: number
          station: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          center_lat?: number
          center_lng?: number
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          polygon?: Json
          radius_m?: number
          station?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "duty_zones_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "duty_zones_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      enforcement_search_log: {
        Row: {
          flight_no: string
          id: string
          result_count: number
          search_date: string | null
          searched_at: string
          searched_by: string
        }
        Insert: {
          flight_no: string
          id?: string
          result_count?: number
          search_date?: string | null
          searched_at?: string
          searched_by: string
        }
        Update: {
          flight_no?: string
          id?: string
          result_count?: number
          search_date?: string | null
          searched_at?: string
          searched_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "enforcement_search_log_searched_by_fkey"
            columns: ["searched_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      incident_photos: {
        Row: {
          id: string
          incident_id: string
          photo_url: string
          uploaded_at: string
        }
        Insert: {
          id?: string
          incident_id: string
          photo_url: string
          uploaded_at?: string
        }
        Update: {
          id?: string
          incident_id?: string
          photo_url?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "incident_photos_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          created_at: string
          description: string
          id: string
          incident_type: string
          photo_url: string | null
          reported_by: string
          reported_by_id: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          transaction_id: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          incident_type: string
          photo_url?: string | null
          reported_by: string
          reported_by_id?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          transaction_id: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          incident_type?: string
          photo_url?: string | null
          reported_by?: string
          reported_by_id?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_reported_by_id_fkey"
            columns: ["reported_by_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string
          created_at: string
          id: string
          incident_id: string | null
          is_read: boolean
          title: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          incident_id?: string | null
          is_read?: boolean
          title: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          incident_id?: string | null
          is_read?: boolean
          title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      offload_items: {
        Row: {
          baggage_tag_no: string
          entry_no: number
          id: string
          reason: string | null
          report_id: string
          weight_kg: number | null
        }
        Insert: {
          baggage_tag_no: string
          entry_no: number
          id?: string
          reason?: string | null
          report_id: string
          weight_kg?: number | null
        }
        Update: {
          baggage_tag_no?: string
          entry_no?: number
          id?: string
          reason?: string | null
          report_id?: string
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "offload_items_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "offload_records"
            referencedColumns: ["id"]
          },
        ]
      }
      offload_records: {
        Row: {
          aircraft_registration: string
          amendment_of: string | null
          created_at: string
          destination: string
          flight_date: string
          flight_no: string
          id: string
          profile_id: string
          remark: string | null
          report_no: string | null
          staff_id: string
          staff_name: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          std: string | null
          submitted_at: string | null
          team: string
          total_bags: number
          updated_at: string
          verified_by_dse_id: string | null
          verified_by_dse_name: string | null
        }
        Insert: {
          aircraft_registration: string
          amendment_of?: string | null
          created_at?: string
          destination: string
          flight_date: string
          flight_no: string
          id?: string
          profile_id: string
          remark?: string | null
          report_no?: string | null
          staff_id: string
          staff_name: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          std?: string | null
          submitted_at?: string | null
          team: string
          total_bags?: number
          updated_at?: string
          verified_by_dse_id?: string | null
          verified_by_dse_name?: string | null
        }
        Update: {
          aircraft_registration?: string
          amendment_of?: string | null
          created_at?: string
          destination?: string
          flight_date?: string
          flight_no?: string
          id?: string
          profile_id?: string
          remark?: string | null
          report_no?: string | null
          staff_id?: string
          staff_name?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          std?: string | null
          submitted_at?: string | null
          team?: string
          total_bags?: number
          updated_at?: string
          verified_by_dse_id?: string | null
          verified_by_dse_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offload_records_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "offload_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offload_records_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      overtime_requests: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          category: string
          created_at: string
          end_at: string
          endorsed_at: string | null
          endorsed_by: string | null
          hours: number | null
          id: string
          linked_duty_id: string | null
          payable_hours: number | null
          profile_id: string
          reason: string
          rejection_reason: string | null
          shift_code: string | null
          start_at: string
          station: string
          status: string
          team: string | null
          updated_at: string
          work_date: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          category: string
          created_at?: string
          end_at: string
          endorsed_at?: string | null
          endorsed_by?: string | null
          hours?: number | null
          id?: string
          linked_duty_id?: string | null
          payable_hours?: number | null
          profile_id: string
          reason: string
          rejection_reason?: string | null
          shift_code?: string | null
          start_at: string
          station: string
          status?: string
          team?: string | null
          updated_at?: string
          work_date: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          category?: string
          created_at?: string
          end_at?: string
          endorsed_at?: string | null
          endorsed_by?: string | null
          hours?: number | null
          id?: string
          linked_duty_id?: string | null
          payable_hours?: number | null
          profile_id?: string
          reason?: string
          rejection_reason?: string | null
          shift_code?: string | null
          start_at?: string
          station?: string
          status?: string
          team?: string | null
          updated_at?: string
          work_date?: string
        }
        Relationships: [
          {
            foreignKeyName: "overtime_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_requests_endorsed_by_fkey"
            columns: ["endorsed_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_requests_linked_duty_id_fkey"
            columns: ["linked_duty_id"]
            isOneToOne: false
            referencedRelation: "duty_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_requests_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "overtime_requests_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      part_a: {
        Row: {
          completed_at: string
          completed_by: string
          id: string
          pic_name: string
          pic_staff_id: string
          remarks: string | null
          signature_hash: string | null
          signature_url: string
          transaction_id: string
          vehicle_search_completed: boolean
        }
        Insert: {
          completed_at?: string
          completed_by: string
          id?: string
          pic_name: string
          pic_staff_id: string
          remarks?: string | null
          signature_hash?: string | null
          signature_url: string
          transaction_id: string
          vehicle_search_completed?: boolean
        }
        Update: {
          completed_at?: string
          completed_by?: string
          id?: string
          pic_name?: string
          pic_staff_id?: string
          remarks?: string | null
          signature_hash?: string | null
          signature_url?: string
          transaction_id?: string
          vehicle_search_completed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "part_a_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_a_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      part_b: {
        Row: {
          avsec_name: string
          avsec_staff_id: string
          checkpoint_date: string
          checkpoint_time: string
          completed_at: string
          completed_by: string
          driver_verified: boolean
          escalation_reason: string | null
          id: string
          observed_driver_id: string | null
          observed_driver_name: string | null
          observed_vehicle_number: string | null
          remarks: string | null
          result: string
          seal_verified: boolean
          signature_hash: string | null
          signature_url: string
          transaction_id: string
          vehicle_verified: boolean
        }
        Insert: {
          avsec_name: string
          avsec_staff_id: string
          checkpoint_date?: string
          checkpoint_time?: string
          completed_at?: string
          completed_by: string
          driver_verified?: boolean
          escalation_reason?: string | null
          id?: string
          observed_driver_id?: string | null
          observed_driver_name?: string | null
          observed_vehicle_number?: string | null
          remarks?: string | null
          result?: string
          seal_verified?: boolean
          signature_hash?: string | null
          signature_url: string
          transaction_id: string
          vehicle_verified?: boolean
        }
        Update: {
          avsec_name?: string
          avsec_staff_id?: string
          checkpoint_date?: string
          checkpoint_time?: string
          completed_at?: string
          completed_by?: string
          driver_verified?: boolean
          escalation_reason?: string | null
          id?: string
          observed_driver_id?: string | null
          observed_driver_name?: string | null
          observed_vehicle_number?: string | null
          remarks?: string | null
          result?: string
          seal_verified?: boolean
          signature_hash?: string | null
          signature_url?: string
          transaction_id?: string
          vehicle_verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "part_b_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_b_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      part_c: {
        Row: {
          avsec_name: string
          avsec_staff_id: string
          checkpoint_date: string
          checkpoint_time: string
          completed_at: string
          completed_by: string
          driver_verified: boolean
          escalation_reason: string | null
          id: string
          observed_driver_id: string | null
          observed_driver_name: string | null
          observed_vehicle_number: string | null
          remarks: string | null
          result: string
          seal_verified: boolean
          signature_hash: string | null
          signature_url: string
          transaction_id: string
          vehicle_verified: boolean
        }
        Insert: {
          avsec_name: string
          avsec_staff_id: string
          checkpoint_date?: string
          checkpoint_time?: string
          completed_at?: string
          completed_by: string
          driver_verified?: boolean
          escalation_reason?: string | null
          id?: string
          observed_driver_id?: string | null
          observed_driver_name?: string | null
          observed_vehicle_number?: string | null
          remarks?: string | null
          result?: string
          seal_verified?: boolean
          signature_hash?: string | null
          signature_url: string
          transaction_id: string
          vehicle_verified?: boolean
        }
        Update: {
          avsec_name?: string
          avsec_staff_id?: string
          checkpoint_date?: string
          checkpoint_time?: string
          completed_at?: string
          completed_by?: string
          driver_verified?: boolean
          escalation_reason?: string | null
          id?: string
          observed_driver_id?: string | null
          observed_driver_name?: string | null
          observed_vehicle_number?: string | null
          remarks?: string | null
          result?: string
          seal_verified?: boolean
          signature_hash?: string | null
          signature_url?: string
          transaction_id?: string
          vehicle_verified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "part_c_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_c_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      part_d: {
        Row: {
          aircraft_identifier: string | null
          checkpoint_date: string
          checkpoint_time: string
          completed_at: string
          completed_by: string
          delivery_location: string
          escalation_reason: string | null
          id: string
          receiver_name: string
          receiver_staff_id: string
          remarks: string | null
          result: string
          seal_intact: boolean
          signature_hash: string | null
          signature_url: string
          transaction_id: string
        }
        Insert: {
          aircraft_identifier?: string | null
          checkpoint_date?: string
          checkpoint_time?: string
          completed_at?: string
          completed_by: string
          delivery_location: string
          escalation_reason?: string | null
          id?: string
          receiver_name: string
          receiver_staff_id: string
          remarks?: string | null
          result?: string
          seal_intact?: boolean
          signature_hash?: string | null
          signature_url: string
          transaction_id: string
        }
        Update: {
          aircraft_identifier?: string | null
          checkpoint_date?: string
          checkpoint_time?: string
          completed_at?: string
          completed_by?: string
          delivery_location?: string
          escalation_reason?: string | null
          id?: string
          receiver_name?: string
          receiver_staff_id?: string
          remarks?: string | null
          result?: string
          seal_intact?: boolean
          signature_hash?: string | null
          signature_url?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_d_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_d_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      part_hub: {
        Row: {
          completed_at: string
          completed_by: string
          confirmed_destination: string
          hub_avsec_name: string
          hub_avsec_staff_id: string
          id: string
          remarks: string | null
          signature_hash: string | null
          signature_url: string
          transaction_id: string
        }
        Insert: {
          completed_at?: string
          completed_by: string
          confirmed_destination: string
          hub_avsec_name: string
          hub_avsec_staff_id: string
          id?: string
          remarks?: string | null
          signature_hash?: string | null
          signature_url: string
          transaction_id: string
        }
        Update: {
          completed_at?: string
          completed_by?: string
          confirmed_destination?: string
          hub_avsec_name?: string
          hub_avsec_staff_id?: string
          id?: string
          remarks?: string | null
          signature_hash?: string | null
          signature_url?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_hub_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_hub_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      part_redq: {
        Row: {
          completed_at: string
          completed_by: string
          id: string
          new_seal_id: string
          old_seal_id: string
          redq_avsec_name: string
          redq_avsec_staff_id: string
          remarks: string | null
          signature_hash: string | null
          signature_url: string
          transaction_id: string
        }
        Insert: {
          completed_at?: string
          completed_by: string
          id?: string
          new_seal_id: string
          old_seal_id: string
          redq_avsec_name: string
          redq_avsec_staff_id: string
          remarks?: string | null
          signature_hash?: string | null
          signature_url: string
          transaction_id: string
        }
        Update: {
          completed_at?: string
          completed_by?: string
          id?: string
          new_seal_id?: string
          old_seal_id?: string
          redq_avsec_name?: string
          redq_avsec_staff_id?: string
          remarks?: string | null
          signature_hash?: string | null
          signature_url?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_redq_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_redq_new_seal_id_fkey"
            columns: ["new_seal_id"]
            isOneToOne: false
            referencedRelation: "seals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_redq_old_seal_id_fkey"
            columns: ["old_seal_id"]
            isOneToOne: false
            referencedRelation: "seals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_redq_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          duty_post: string | null
          email: string
          id: string
          name: string
          role: Database["public"]["Enums"]["user_role"]
          staff_no: string
          station: string | null
          status: Database["public"]["Enums"]["profile_status"]
          team: string | null
          unified_role: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          duty_post?: string | null
          email: string
          id: string
          name?: string
          role?: Database["public"]["Enums"]["user_role"]
          staff_no?: string
          station?: string | null
          status?: Database["public"]["Enums"]["profile_status"]
          team?: string | null
          unified_role?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          duty_post?: string | null
          email?: string
          id?: string
          name?: string
          role?: Database["public"]["Enums"]["user_role"]
          staff_no?: string
          station?: string | null
          status?: Database["public"]["Enums"]["profile_status"]
          team?: string | null
          unified_role?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      report_acknowledgements: {
        Row: {
          acknowledged_at: string
          acknowledged_by: string
          id: string
          report_id: string
          report_type: string
        }
        Insert: {
          acknowledged_at?: string
          acknowledged_by: string
          id?: string
          report_id: string
          report_type: string
        }
        Update: {
          acknowledged_at?: string
          acknowledged_by?: string
          id?: string
          report_id?: string
          report_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_acknowledgements_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_attachments: {
        Row: {
          created_at: string
          file_name: string
          id: string
          mime_type: string
          report_id: string
          report_type: string
          size_bytes: number
          storage_path: string
          uploaded_by: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          mime_type: string
          report_id: string
          report_type: string
          size_bytes: number
          storage_path: string
          uploaded_by: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          mime_type?: string
          report_id?: string
          report_type?: string
          size_bytes?: number
          storage_path?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_counters: {
        Row: {
          form_code: string
          last_seq: number
          report_date: string
        }
        Insert: {
          form_code: string
          last_seq?: number
          report_date: string
        }
        Update: {
          form_code?: string
          last_seq?: number
          report_date?: string
        }
        Relationships: []
      }
      report_drafts: {
        Row: {
          data: Json
          id: string
          profile_id: string
          report_type: string
          updated_at: string
        }
        Insert: {
          data?: Json
          id?: string
          profile_id: string
          report_type: string
          updated_at?: string
        }
        Update: {
          data?: Json
          id?: string
          profile_id?: string
          report_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_drafts_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec013: {
        Row: {
          acknowledgement: boolean
          amendment_of: string | null
          corrective_action: string | null
          created_at: string
          date_time_in: string
          date_time_out: string
          id: string
          profile_id: string
          remark: string | null
          report_no: string | null
          staff_id: string
          staff_name: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          submitted_at: string | null
          team: string
          updated_at: string
        }
        Insert: {
          acknowledgement?: boolean
          amendment_of?: string | null
          corrective_action?: string | null
          created_at?: string
          date_time_in: string
          date_time_out: string
          id?: string
          profile_id: string
          remark?: string | null
          report_no?: string | null
          staff_id: string
          staff_name: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team: string
          updated_at?: string
        }
        Update: {
          acknowledgement?: boolean
          amendment_of?: string | null
          corrective_action?: string | null
          created_at?: string
          date_time_in?: string
          date_time_out?: string
          id?: string
          profile_id?: string
          remark?: string | null
          report_no?: string | null
          staff_id?: string
          staff_name?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec013_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "report_sec013"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec013_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec013_profiling_duties: {
        Row: {
          description: string
          duty_area: string
          entry_no: number
          id: string
          incident_remark: string | null
          location: string
          report_id: string
          sector_flight: string
          time_from: string
          time_to: string
        }
        Insert: {
          description: string
          duty_area: string
          entry_no: number
          id?: string
          incident_remark?: string | null
          location: string
          report_id: string
          sector_flight: string
          time_from: string
          time_to: string
        }
        Update: {
          description?: string
          duty_area?: string
          entry_no?: number
          id?: string
          incident_remark?: string | null
          location?: string
          report_id?: string
          sector_flight?: string
          time_from?: string
          time_to?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec013_profiling_duties_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "report_sec013"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec014: {
        Row: {
          acknowledgement: boolean
          amendment_of: string | null
          created_at: string
          date_time_in: string
          date_time_out: string | null
          id: string
          profile_id: string
          remark: string
          report_no: string | null
          staff_id: string
          staff_name: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          submitted_at: string | null
          team: string
          updated_at: string
        }
        Insert: {
          acknowledgement?: boolean
          amendment_of?: string | null
          created_at?: string
          date_time_in: string
          date_time_out?: string | null
          id?: string
          profile_id: string
          remark: string
          report_no?: string | null
          staff_id: string
          staff_name: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team: string
          updated_at?: string
        }
        Update: {
          acknowledgement?: boolean
          amendment_of?: string | null
          created_at?: string
          date_time_in?: string
          date_time_out?: string | null
          id?: string
          profile_id?: string
          remark?: string
          report_no?: string | null
          staff_id?: string
          staff_name?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec014_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "report_sec014"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec014_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec014_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      report_sec014_patrols: {
        Row: {
          description: string
          entry_no: number
          id: string
          location: string | null
          report_id: string
          time_from: string | null
          time_to: string | null
        }
        Insert: {
          description?: string
          entry_no: number
          id?: string
          location?: string | null
          report_id: string
          time_from?: string | null
          time_to?: string | null
        }
        Update: {
          description?: string
          entry_no?: number
          id?: string
          location?: string | null
          report_id?: string
          time_from?: string | null
          time_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "report_sec014_patrols_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "report_sec014"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec016: {
        Row: {
          aircraft_type: string
          aircraft_type_other: string | null
          amendment_of: string | null
          assisted_by: string
          ata_atd: string
          bay_no: string
          cargo_hold_checked: string
          checked_items: string[]
          created_at: string
          discrepancies: string
          do_infmd: string
          duty_date: string
          duty_hour: string
          flight: string
          id: string
          inbound_baggage: string
          inbound_cargo: string
          inbound_co_mail: string
          offload_baggage_tag_no: string
          offload_destination: string
          offload_flight_no: string
          offload_remark: string
          offload_total_baggage: string
          origin_arr_dep: string
          outbound_baggage: string
          outbound_cargo: string
          outbound_co_mail: string
          profile_id: string
          ramp_staff_1: string
          ramp_staff_2: string
          ramp_staff_3: string
          ramp_staff_4: string
          ramp_staff_5: string
          reason_for_delay: string | null
          reg_no: string
          report_no: string | null
          shift_leader: string
          sta_std: string
          staff_frisked: string
          staff_name: string
          staff_no: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          submitted_at: string | null
          team: string
          updated_at: string
        }
        Insert: {
          aircraft_type: string
          aircraft_type_other?: string | null
          amendment_of?: string | null
          assisted_by: string
          ata_atd: string
          bay_no: string
          cargo_hold_checked: string
          checked_items?: string[]
          created_at?: string
          discrepancies: string
          do_infmd: string
          duty_date: string
          duty_hour: string
          flight: string
          id?: string
          inbound_baggage: string
          inbound_cargo: string
          inbound_co_mail: string
          offload_baggage_tag_no: string
          offload_destination: string
          offload_flight_no: string
          offload_remark: string
          offload_total_baggage: string
          origin_arr_dep: string
          outbound_baggage: string
          outbound_cargo: string
          outbound_co_mail: string
          profile_id: string
          ramp_staff_1: string
          ramp_staff_2: string
          ramp_staff_3: string
          ramp_staff_4: string
          ramp_staff_5: string
          reason_for_delay?: string | null
          reg_no: string
          report_no?: string | null
          shift_leader: string
          sta_std: string
          staff_frisked: string
          staff_name: string
          staff_no: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team: string
          updated_at?: string
        }
        Update: {
          aircraft_type?: string
          aircraft_type_other?: string | null
          amendment_of?: string | null
          assisted_by?: string
          ata_atd?: string
          bay_no?: string
          cargo_hold_checked?: string
          checked_items?: string[]
          created_at?: string
          discrepancies?: string
          do_infmd?: string
          duty_date?: string
          duty_hour?: string
          flight?: string
          id?: string
          inbound_baggage?: string
          inbound_cargo?: string
          inbound_co_mail?: string
          offload_baggage_tag_no?: string
          offload_destination?: string
          offload_flight_no?: string
          offload_remark?: string
          offload_total_baggage?: string
          origin_arr_dep?: string
          outbound_baggage?: string
          outbound_cargo?: string
          outbound_co_mail?: string
          profile_id?: string
          ramp_staff_1?: string
          ramp_staff_2?: string
          ramp_staff_3?: string
          ramp_staff_4?: string
          ramp_staff_5?: string
          reason_for_delay?: string | null
          reg_no?: string
          report_no?: string | null
          shift_leader?: string
          sta_std?: string
          staff_frisked?: string
          staff_name?: string
          staff_no?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec016_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "report_sec016"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec016_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec016_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      report_sec018: {
        Row: {
          acknowledgement: boolean
          amendment_of: string | null
          created_at: string
          date_time: string
          id: string
          profile_id: string
          report_no: string | null
          staff_name: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          submitted_at: string | null
          team: string
          updated_at: string
        }
        Insert: {
          acknowledgement?: boolean
          amendment_of?: string | null
          created_at?: string
          date_time: string
          id?: string
          profile_id: string
          report_no?: string | null
          staff_name: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team: string
          updated_at?: string
        }
        Update: {
          acknowledgement?: boolean
          amendment_of?: string | null
          created_at?: string
          date_time?: string
          id?: string
          profile_id?: string
          report_no?: string | null
          staff_name?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec018_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "report_sec018"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec018_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec018_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      report_sec018_patrols: {
        Row: {
          aircraft_type: string | null
          description: string
          entry_no: number
          id: string
          parking_bay: string | null
          reg_no: string | null
          report_id: string
          time_from: string | null
          time_to: string | null
        }
        Insert: {
          aircraft_type?: string | null
          description?: string
          entry_no: number
          id?: string
          parking_bay?: string | null
          reg_no?: string | null
          report_id: string
          time_from?: string | null
          time_to?: string | null
        }
        Update: {
          aircraft_type?: string | null
          description?: string
          entry_no?: number
          id?: string
          parking_bay?: string | null
          reg_no?: string | null
          report_id?: string
          time_from?: string | null
          time_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "report_sec018_patrols_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "report_sec018"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec029: {
        Row: {
          acknowledgement: boolean
          aircraft_registration: string
          aircraft_type: string
          amendment_of: string | null
          assisted_by_id: string
          assisted_by_name: string
          created_at: string
          d_remark: string | null
          declaration: string
          flight_no: string
          id: string
          parking_bay: string
          pic_informed: string
          profile_id: string
          report_no: string | null
          staff_id: string
          staff_name: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          std: string
          submitted_at: string | null
          supervising_officer_id: string
          supervising_officer_name: string
          team: string
          time_commence: string
          time_completed: string
          updated_at: string
        }
        Insert: {
          acknowledgement?: boolean
          aircraft_registration: string
          aircraft_type: string
          amendment_of?: string | null
          assisted_by_id: string
          assisted_by_name: string
          created_at?: string
          d_remark?: string | null
          declaration: string
          flight_no: string
          id?: string
          parking_bay: string
          pic_informed: string
          profile_id: string
          report_no?: string | null
          staff_id: string
          staff_name: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          std: string
          submitted_at?: string | null
          supervising_officer_id: string
          supervising_officer_name: string
          team: string
          time_commence: string
          time_completed: string
          updated_at?: string
        }
        Update: {
          acknowledgement?: boolean
          aircraft_registration?: string
          aircraft_type?: string
          amendment_of?: string | null
          assisted_by_id?: string
          assisted_by_name?: string
          created_at?: string
          d_remark?: string | null
          declaration?: string
          flight_no?: string
          id?: string
          parking_bay?: string
          pic_informed?: string
          profile_id?: string
          report_no?: string | null
          staff_id?: string
          staff_name?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          std?: string
          submitted_at?: string | null
          supervising_officer_id?: string
          supervising_officer_name?: string
          team?: string
          time_commence?: string
          time_completed?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec029_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "report_sec029"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec029_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec029_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      report_sec029_items: {
        Row: {
          checked: string
          id: string
          item_code: string
          remark_text: string | null
          remark_type: string
          report_id: string
        }
        Insert: {
          checked: string
          id?: string
          item_code: string
          remark_text?: string | null
          remark_type: string
          report_id: string
        }
        Update: {
          checked?: string
          id?: string
          item_code?: string
          remark_text?: string | null
          remark_type?: string
          report_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec029_items_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "report_sec029"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec033: {
        Row: {
          amendment_of: string | null
          created_at: string
          id: string
          profile_id: string
          report_date: string
          report_no: string | null
          report_time: string
          staff_id: string
          staff_name: string
          station: string
          status: Database["public"]["Enums"]["report_status"]
          submitted_at: string | null
          team: string
          updated_at: string
        }
        Insert: {
          amendment_of?: string | null
          created_at?: string
          id?: string
          profile_id: string
          report_date: string
          report_no?: string | null
          report_time: string
          staff_id: string
          staff_name: string
          station: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team: string
          updated_at?: string
        }
        Update: {
          amendment_of?: string | null
          created_at?: string
          id?: string
          profile_id?: string
          report_date?: string
          report_no?: string | null
          report_time?: string
          staff_id?: string
          staff_name?: string
          station?: string
          status?: Database["public"]["Enums"]["report_status"]
          submitted_at?: string | null
          team?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec033_amendment_of_fkey"
            columns: ["amendment_of"]
            isOneToOne: false
            referencedRelation: "report_sec033"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_sec033_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_sec033_hold_checks: {
        Row: {
          aircraft_registration_no: string
          entry_no: number
          id: string
          parking_bay_no: string
          remarks: string | null
          report_id: string
        }
        Insert: {
          aircraft_registration_no: string
          entry_no: number
          id?: string
          parking_bay_no: string
          remarks?: string | null
          report_id: string
        }
        Update: {
          aircraft_registration_no?: string
          entry_no?: number
          id?: string
          parking_bay_no?: string
          remarks?: string | null
          report_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_sec033_hold_checks_report_id_fkey"
            columns: ["report_id"]
            isOneToOne: false
            referencedRelation: "report_sec033"
            referencedColumns: ["id"]
          },
        ]
      }
      seal_verifications: {
        Row: {
          checkpoint: string
          entered_seal_number: string
          id: string
          matched: boolean
          observed_seal_color: string | null
          photo_url: string | null
          seal_id: string
          verified_at: string
          verified_by: string | null
        }
        Insert: {
          checkpoint: string
          entered_seal_number: string
          id?: string
          matched: boolean
          observed_seal_color?: string | null
          photo_url?: string | null
          seal_id: string
          verified_at?: string
          verified_by?: string | null
        }
        Update: {
          checkpoint?: string
          entered_seal_number?: string
          id?: string
          matched?: boolean
          observed_seal_color?: string | null
          photo_url?: string | null
          seal_id?: string
          verified_at?: string
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "seal_verifications_seal_id_fkey"
            columns: ["seal_id"]
            isOneToOne: false
            referencedRelation: "seals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seal_verifications_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      seals: {
        Row: {
          applied_at: string
          id: string
          seal_color: string
          seal_number: string
          seal_type: string
          superseded_at: string | null
          superseded_by: string | null
          superseded_reason: string | null
          transaction_id: string
        }
        Insert: {
          applied_at?: string
          id?: string
          seal_color: string
          seal_number: string
          seal_type?: string
          superseded_at?: string | null
          superseded_by?: string | null
          superseded_reason?: string | null
          transaction_id: string
        }
        Update: {
          applied_at?: string
          id?: string
          seal_color?: string
          seal_number?: string
          seal_type?: string
          superseded_at?: string | null
          superseded_by?: string | null
          superseded_reason?: string | null
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "seals_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "seals_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: false
            referencedRelation: "transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      segment_timeouts: {
        Row: {
          created_at: string
          direction: string
          from_status: string
          id: string
          limit_minutes: number | null
          to_status: string
        }
        Insert: {
          created_at?: string
          direction: string
          from_status: string
          id?: string
          limit_minutes?: number | null
          to_status: string
        }
        Update: {
          created_at?: string
          direction?: string
          from_status?: string
          id?: string
          limit_minutes?: number | null
          to_status?: string
        }
        Relationships: []
      }
      sheet_sync_config: {
        Row: {
          enabled: boolean
          id: boolean
          updated_at: string
          webhook_secret: string | null
          webhook_url: string | null
        }
        Insert: {
          enabled?: boolean
          id?: boolean
          updated_at?: string
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Update: {
          enabled?: boolean
          id?: boolean
          updated_at?: string
          webhook_secret?: string | null
          webhook_url?: string | null
        }
        Relationships: []
      }
      sheet_sync_queue: {
        Row: {
          attempts: number
          created_at: string
          id: string
          last_error: string | null
          report_id: string
          report_no: string | null
          report_type: string
          sent_at: string | null
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          report_id: string
          report_no?: string | null
          report_type: string
          sent_at?: string | null
          status?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          id?: string
          last_error?: string | null
          report_id?: string
          report_no?: string | null
          report_type?: string
          sent_at?: string | null
          status?: string
        }
        Relationships: []
      }
      shifts: {
        Row: {
          code: string
          color_hex: string | null
          default_end: string | null
          default_start: string | null
          display_order: number
          id: string
          label: string
        }
        Insert: {
          code: string
          color_hex?: string | null
          default_end?: string | null
          default_start?: string | null
          display_order?: number
          id?: string
          label: string
        }
        Update: {
          code?: string
          color_hex?: string | null
          default_end?: string | null
          default_start?: string | null
          display_order?: number
          id?: string
          label?: string
        }
        Relationships: []
      }
      station_teams: {
        Row: {
          active: boolean
          created_at: string
          display_order: number
          id: string
          station: string
          team: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_order?: number
          id?: string
          station: string
          team: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_order?: number
          id?: string
          station?: string
          team?: string
        }
        Relationships: [
          {
            foreignKeyName: "station_teams_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
        ]
      }
      stations: {
        Row: {
          active: boolean
          code: string
          label: string
        }
        Insert: {
          active?: boolean
          code: string
          label: string
        }
        Update: {
          active?: boolean
          code?: string
          label?: string
        }
        Relationships: []
      }
      team_rosters: {
        Row: {
          created_at: string
          end_time: string | null
          id: string
          notes: string | null
          roster_date: string
          set_by: string
          shift_code: string
          start_time: string | null
          station: string
          team: string
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          created_at?: string
          end_time?: string | null
          id?: string
          notes?: string | null
          roster_date: string
          set_by: string
          shift_code: string
          start_time?: string | null
          station: string
          team: string
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          created_at?: string
          end_time?: string | null
          id?: string
          notes?: string | null
          roster_date?: string
          set_by?: string
          shift_code?: string
          start_time?: string | null
          station?: string
          team?: string
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "team_rosters_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_rosters_shift_code_fkey"
            columns: ["shift_code"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "team_rosters_station_fkey"
            columns: ["station"]
            isOneToOne: false
            referencedRelation: "stations"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "team_rosters_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "duty_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          active: boolean
          code: string
          label: string
        }
        Insert: {
          active?: boolean
          code: string
          label: string
        }
        Update: {
          active?: boolean
          code?: string
          label?: string
        }
        Relationships: []
      }
      transaction_counters: {
        Row: {
          counter: number
          year: number
        }
        Insert: {
          counter?: number
          year: number
        }
        Update: {
          counter?: number
          year?: number
        }
        Relationships: []
      }
      transactions: {
        Row: {
          aircraft_registration: string | null
          archived: boolean
          archived_at: string | null
          cargo_types: string[]
          catering_company_id: string | null
          completed_at: string | null
          completed_form_url: string | null
          created_at: string
          created_by: string
          current_stage: string
          direction: string
          driver_id: string
          driver_id_ref: string | null
          driver_name: string
          escalation_reason: string | null
          escort_officer_name: string | null
          escort_officer_staff_id: string | null
          escort_vehicle_number: string | null
          flight_number: string | null
          hub_destination: string | null
          id: string
          lifecycle_status: string | null
          part_d_skip_reason: string | null
          part_d_skipped: boolean
          qr_token: string | null
          route: string
          seal_number: string | null
          station: string | null
          status: string
          status_entered_at: string
          supplies_boxes: number | null
          supplies_carts: number | null
          supplies_oven_racks: number | null
          supplies_pallets: number | null
          supplies_smu: number | null
          supplies_total: number | null
          transaction_number: string
          trolley_count: number
          updated_at: string
          vehicle_id: string | null
          vehicle_number: string
        }
        Insert: {
          aircraft_registration?: string | null
          archived?: boolean
          archived_at?: string | null
          cargo_types?: string[]
          catering_company_id?: string | null
          completed_at?: string | null
          completed_form_url?: string | null
          created_at?: string
          created_by: string
          current_stage: string
          direction: string
          driver_id: string
          driver_id_ref?: string | null
          driver_name: string
          escalation_reason?: string | null
          escort_officer_name?: string | null
          escort_officer_staff_id?: string | null
          escort_vehicle_number?: string | null
          flight_number?: string | null
          hub_destination?: string | null
          id?: string
          lifecycle_status?: string | null
          part_d_skip_reason?: string | null
          part_d_skipped?: boolean
          qr_token?: string | null
          route?: string
          seal_number?: string | null
          station?: string | null
          status?: string
          status_entered_at?: string
          supplies_boxes?: number | null
          supplies_carts?: number | null
          supplies_oven_racks?: number | null
          supplies_pallets?: number | null
          supplies_smu?: number | null
          supplies_total?: number | null
          transaction_number?: string
          trolley_count?: number
          updated_at?: string
          vehicle_id?: string | null
          vehicle_number: string
        }
        Update: {
          aircraft_registration?: string | null
          archived?: boolean
          archived_at?: string | null
          cargo_types?: string[]
          catering_company_id?: string | null
          completed_at?: string | null
          completed_form_url?: string | null
          created_at?: string
          created_by?: string
          current_stage?: string
          direction?: string
          driver_id?: string
          driver_id_ref?: string | null
          driver_name?: string
          escalation_reason?: string | null
          escort_officer_name?: string | null
          escort_officer_staff_id?: string | null
          escort_vehicle_number?: string | null
          flight_number?: string | null
          hub_destination?: string | null
          id?: string
          lifecycle_status?: string | null
          part_d_skip_reason?: string | null
          part_d_skipped?: boolean
          qr_token?: string | null
          route?: string
          seal_number?: string | null
          station?: string | null
          status?: string
          status_entered_at?: string
          supplies_boxes?: number | null
          supplies_carts?: number | null
          supplies_oven_racks?: number | null
          supplies_pallets?: number | null
          supplies_smu?: number | null
          supplies_total?: number | null
          transaction_number?: string
          trolley_count?: number
          updated_at?: string
          vehicle_id?: string | null
          vehicle_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "transactions_catering_company_id_fkey"
            columns: ["catering_company_id"]
            isOneToOne: false
            referencedRelation: "catering_companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_driver_id_ref_fkey"
            columns: ["driver_id_ref"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "transactions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          duty_post: string | null
          email: string
          id: string
          name: string
          preferred_language: string
          role: string
          staff_id: string
          status: string
          unified_role: string | null
        }
        Insert: {
          created_at?: string
          duty_post?: string | null
          email: string
          id: string
          name: string
          preferred_language?: string
          role: string
          staff_id: string
          status?: string
          unified_role?: string | null
        }
        Update: {
          created_at?: string
          duty_post?: string | null
          email?: string
          id?: string
          name?: string
          preferred_language?: string
          role?: string
          staff_id?: string
          status?: string
          unified_role?: string | null
        }
        Relationships: []
      }
      vehicles: {
        Row: {
          airport_pass_number: string | null
          catering_company_id: string | null
          created_at: string
          id: string
          is_active: boolean
          pass_expiry_date: string | null
          truck_registration_number: string | null
          truck_type: string | null
          vehicle_number: string
        }
        Insert: {
          airport_pass_number?: string | null
          catering_company_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          pass_expiry_date?: string | null
          truck_registration_number?: string | null
          truck_type?: string | null
          vehicle_number: string
        }
        Update: {
          airport_pass_number?: string | null
          catering_company_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          pass_expiry_date?: string | null
          truck_registration_number?: string | null
          truck_type?: string | null
          vehicle_number?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_catering_company_id_fkey"
            columns: ["catering_company_id"]
            isOneToOne: false
            referencedRelation: "catering_companies"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_part_a: {
        Row: {
          completed_at: string
          completed_by: string
          driver_name: string
          id: string
          nric_number: string
          seal_number: string
          signature_url: string
          transaction_id: string
        }
        Insert: {
          completed_at?: string
          completed_by: string
          driver_name: string
          id?: string
          nric_number: string
          seal_number: string
          signature_url: string
          transaction_id: string
        }
        Update: {
          completed_at?: string
          completed_by?: string
          driver_name?: string
          id?: string
          nric_number?: string
          seal_number?: string
          signature_url?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_part_a_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_part_a_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "vendor_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_part_b: {
        Row: {
          avsec_name: string
          avsec_staff_id: string
          completed_at: string
          completed_by: string
          driver_name: string
          driver_nric: string
          id: string
          remarks: string | null
          seal_number: string
          signature_url: string
          transaction_id: string
          vehicle_registration_no: string
        }
        Insert: {
          avsec_name: string
          avsec_staff_id: string
          completed_at?: string
          completed_by: string
          driver_name: string
          driver_nric: string
          id?: string
          remarks?: string | null
          seal_number: string
          signature_url: string
          transaction_id: string
          vehicle_registration_no: string
        }
        Update: {
          avsec_name?: string
          avsec_staff_id?: string
          completed_at?: string
          completed_by?: string
          driver_name?: string
          driver_nric?: string
          id?: string
          remarks?: string | null
          seal_number?: string
          signature_url?: string
          transaction_id?: string
          vehicle_registration_no?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_part_b_completed_by_fkey"
            columns: ["completed_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_part_b_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "vendor_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_part_c: {
        Row: {
          created_at: string
          id: string
          transaction_id: string
          updated_at: string
          vendor_driver_id: string | null
          vendor_driver_name: string | null
          vendor_signature_url: string | null
          vendor_signed_at: string | null
          warehouse_pic_id: string | null
          warehouse_pic_name: string | null
          warehouse_signature_url: string | null
          warehouse_signed_at: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          transaction_id: string
          updated_at?: string
          vendor_driver_id?: string | null
          vendor_driver_name?: string | null
          vendor_signature_url?: string | null
          vendor_signed_at?: string | null
          warehouse_pic_id?: string | null
          warehouse_pic_name?: string | null
          warehouse_signature_url?: string | null
          warehouse_signed_at?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          transaction_id?: string
          updated_at?: string
          vendor_driver_id?: string | null
          vendor_driver_name?: string | null
          vendor_signature_url?: string | null
          vendor_signed_at?: string | null
          warehouse_pic_id?: string | null
          warehouse_pic_name?: string | null
          warehouse_signature_url?: string | null
          warehouse_signed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vendor_part_c_transaction_id_fkey"
            columns: ["transaction_id"]
            isOneToOne: true
            referencedRelation: "vendor_transactions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_part_c_vendor_driver_id_fkey"
            columns: ["vendor_driver_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vendor_part_c_warehouse_pic_id_fkey"
            columns: ["warehouse_pic_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_transaction_counters: {
        Row: {
          counter: number
          year: number
        }
        Insert: {
          counter?: number
          year: number
        }
        Update: {
          counter?: number
          year?: number
        }
        Relationships: []
      }
      vendor_transactions: {
        Row: {
          completed_at: string | null
          completed_form_url: string | null
          created_at: string
          created_by: string
          id: string
          qr_token: string | null
          status: string
          transaction_number: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          completed_form_url?: string | null
          created_at?: string
          created_by: string
          id?: string
          qr_token?: string | null
          status?: string
          transaction_number?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          completed_form_url?: string | null
          created_at?: string
          created_by?: string
          id?: string
          qr_token?: string | null
          status?: string
          transaction_number?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_transactions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_flight_attendance: {
        Row: {
          aircraft_registration: string | null
          flight_date: string | null
          flight_no: string | null
          location_detail: string | null
          profile_id: string | null
          report_id: string | null
          report_type: string | null
          staff_id: string | null
          staff_name: string | null
          station: string | null
          submitted_at: string | null
          team: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      archive_all_pending: { Args: { p_reason?: string }; Returns: number }
      can_acknowledge_report: {
        Args: { p_report_id: string; p_report_type: string }
        Returns: boolean
      }
      can_view_report: {
        Args: { p_report_id: string; p_report_type: string }
        Returns: boolean
      }
      current_role_name: {
        Args: never
        Returns: Database["public"]["Enums"]["user_role"]
      }
      current_role_rank: { Args: never; Returns: number }
      current_station: { Args: never; Returns: string }
      current_status: {
        Args: never
        Returns: Database["public"]["Enums"]["profile_status"]
      }
      current_team: { Args: never; Returns: string }
      current_user_role: { Args: never; Returns: string }
      escalate_timeouts: { Args: never; Returns: number }
      flag_attendance_anomalies: {
        Args: { p_grace_hours?: number }
        Returns: undefined
      }
      get_admin_emails: { Args: never; Returns: string[] }
      get_report_submitter: {
        Args: { p_report_id: string; p_report_type: string }
        Returns: {
          profile_id: string
          station: string
          team: string
        }[]
      }
      is_monitor_or_above: { Args: never; Returns: boolean }
      next_report_no: {
        Args: { p_form_code: string; p_report_date: string }
        Returns: string
      }
      next_transaction_number: { Args: never; Returns: string }
      next_vendor_transaction_number: { Args: never; Returns: string }
      request_device_info: { Args: never; Returns: string }
      request_ip: { Args: never; Returns: unknown }
      role_rank: {
        Args: { r: Database["public"]["Enums"]["user_role"] }
        Returns: number
      }
      run_attendance_sweep: { Args: never; Returns: undefined }
      search_flight_attendance: {
        Args: { p_date?: string; p_flight_no: string }
        Returns: {
          aircraft_registration: string | null
          flight_date: string | null
          flight_no: string | null
          location_detail: string | null
          profile_id: string | null
          report_id: string | null
          report_type: string | null
          staff_id: string | null
          staff_name: string | null
          station: string | null
          submitted_at: string | null
          team: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "v_flight_attendance"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      skip_part_d: {
        Args: { p_reason: string; p_transaction_id: string }
        Returns: undefined
      }
      submitter_role_rank: { Args: { p_profile_id: string }; Returns: number }
      trigger_sheets_sync: { Args: never; Returns: undefined }
    }
    Enums: {
      profile_status: "pending" | "approved" | "rejected" | "deactivated"
      report_status: "draft" | "submitted"
      user_role: "ASO" | "SO" | "DSE" | "ADMIN" | "ENFORCEMENT" | "MANAGEMENT"
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
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
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
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
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      profile_status: ["pending", "approved", "rejected", "deactivated"],
      report_status: ["draft", "submitted"],
      user_role: ["ASO", "SO", "DSE", "ADMIN", "ENFORCEMENT", "MANAGEMENT"],
    },
  },
} as const
