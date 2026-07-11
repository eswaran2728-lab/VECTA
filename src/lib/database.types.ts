export type Role =
  | "warehouse_pic"
  | "sra_warehouse_pic"
  | "post2_avsec"
  | "post6_avsec"
  | "receiver"
  | "supervisor";

export type TransactionStatus =
  | "CREATED"
  | "INFLIGHT_POST_APPROVED"
  | "AIRPORT_POST_APPROVED"
  | "COMPLETED"
  | "ESCALATED";

export type Direction = "OUTBOUND" | "INBOUND";

export type DeliveryLocation = "SRA_WAREHOUSE" | "AIRCRAFT";

export type IncidentType =
  | "BROKEN_SEAL"
  | "SEAL_MISMATCH"
  | "UNAUTHORIZED_DRIVER"
  | "UNAUTHORIZED_VEHICLE"
  | "EXPIRED_PASS"
  | "WRONG_SEAL_COLOR"
  | "TIMEOUT"
  | "OTHER";

export type SealType = "TRUCK_SEAL" | "TROLLEY" | "OTHER";
export type SealColor = "BLUE" | "GREEN" | "OTHER";
export type SealCheckpoint = "INFLIGHT_POST" | "AIRPORT_POST" | "PART_D";

export type Seal = {
  id: string;
  transaction_id: string;
  seal_number: string;
  seal_type: SealType;
  seal_color: SealColor;
  applied_at: string;
}

export type SealVerification = {
  id: string;
  seal_id: string;
  checkpoint: SealCheckpoint;
  entered_seal_number: string;
  matched: boolean;
  verified_by: string | null;
  verified_at: string;
  photo_url: string | null;
}

export type CateringCompany = {
  id: string;
  name: string;
  code: string;
  is_active: boolean;
  created_at: string;
}

export type VehicleRecord = {
  id: string;
  vehicle_number: string;
  catering_company_id: string | null;
  airport_pass_number: string | null;
  pass_expiry_date: string | null;
  is_active: boolean;
  created_at: string;
}

export type DriverRecord = {
  id: string;
  name: string;
  driver_id: string;
  catering_company_id: string | null;
  airport_pass_number: string | null;
  pass_expiry_date: string | null;
  is_active: boolean;
  created_at: string;
}

export type UserProfile = {
  id: string;
  name: string;
  staff_id: string;
  email: string;
  role: Role;
  preferred_language: "en" | "ms";
  created_at: string;
}

export type Transaction = {
  id: string;
  transaction_number: string;
  direction: Direction;
  vehicle_number: string;
  driver_name: string;
  driver_id: string;
  /** @deprecated superseded by the seals table; kept for legacy rows */
  seal_number: string | null;
  /** Signed QR token issued at creation (stateless; regenerated for display). */
  qr_token: string | null;
  flight_number: string | null;
  aircraft_registration: string | null;
  catering_company_id: string | null;
  vehicle_id: string | null;
  driver_id_ref: string | null;
  trolley_count: number;
  escort_officer_name: string | null;
  escort_officer_staff_id: string | null;
  status: TransactionStatus;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type PartA = {
  id: string;
  transaction_id: string;
  pic_name: string;
  pic_staff_id: string;
  vehicle_search_completed: boolean;
  signature_url: string;
  signature_hash: string | null;
  remarks: string | null;
  completed_by: string;
  completed_at: string;
}

export type PartBC = {
  id: string;
  transaction_id: string;
  avsec_name: string;
  avsec_staff_id: string;
  vehicle_verified: boolean;
  driver_verified: boolean;
  seal_verified: boolean;
  signature_url: string;
  signature_hash: string | null;
  remarks: string | null;
  completed_by: string;
  completed_at: string;
}

export type PartD = {
  id: string;
  transaction_id: string;
  delivery_location: DeliveryLocation;
  receiver_name: string;
  receiver_staff_id: string;
  seal_intact: boolean;
  signature_url: string;
  signature_hash: string | null;
  remarks: string | null;
  completed_by: string;
  completed_at: string;
}

export type IncidentStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED" | "CLOSED";

export type Incident = {
  id: string;
  transaction_id: string;
  incident_type: IncidentType;
  description: string;
  reported_by: string;
  reported_by_id: string | null;
  photo_url: string | null;
  status: IncidentStatus;
  resolved_by: string | null;
  resolution_notes: string | null;
  resolved_at: string | null;
  created_at: string;
}

export type IncidentPhoto = {
  id: string;
  incident_id: string;
  photo_url: string;
  uploaded_at: string;
}

export type AppNotification = {
  id: string;
  user_id: string;
  incident_id: string | null;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
}

export type AuditLog = {
  id: string;
  transaction_id: string | null;
  action: string;
  performed_by: string;
  performed_by_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  performed_at: string;
}

export type TransactionWithParts = Transaction & {
  part_a: PartA | null;
  part_b: PartBC | null;
  part_c: PartBC | null;
  part_d: PartD | null;
  incidents: Incident[];
}

export type Database = {
  public: {
    Tables: {
      users: {
        Row: UserProfile;
        Insert: Omit<UserProfile, "created_at" | "preferred_language"> & {
          created_at?: string;
          preferred_language?: "en" | "ms";
        };
        Update: Partial<UserProfile>;
        Relationships: [];
      };
      transactions: {
        Row: Transaction;
        Insert: Omit<
          Transaction,
          | "id"
          | "transaction_number"
          | "status"
          | "created_at"
          | "updated_at"
          | "completed_at"
          | "qr_token"
          | "flight_number"
          | "aircraft_registration"
          | "catering_company_id"
          | "vehicle_id"
          | "driver_id_ref"
          | "trolley_count"
          | "escort_officer_name"
          | "escort_officer_staff_id"
        > & {
          id?: string;
          transaction_number?: string;
          status?: TransactionStatus;
          qr_token?: string | null;
          flight_number?: string | null;
          aircraft_registration?: string | null;
          catering_company_id?: string | null;
          vehicle_id?: string | null;
          driver_id_ref?: string | null;
          trolley_count?: number;
          escort_officer_name?: string | null;
          escort_officer_staff_id?: string | null;
        };
        Update: Partial<Transaction>;
        Relationships: [];
      };
      part_a: {
        Row: PartA;
        Insert: Omit<PartA, "id" | "completed_at"> & { id?: string; completed_at?: string };
        Update: Partial<PartA>;
        Relationships: [];
      };
      part_b: {
        Row: PartBC;
        Insert: Omit<PartBC, "id" | "completed_at"> & { id?: string; completed_at?: string };
        Update: Partial<PartBC>;
        Relationships: [];
      };
      part_c: {
        Row: PartBC;
        Insert: Omit<PartBC, "id" | "completed_at"> & { id?: string; completed_at?: string };
        Update: Partial<PartBC>;
        Relationships: [];
      };
      part_d: {
        Row: PartD;
        Insert: Omit<PartD, "id" | "completed_at"> & { id?: string; completed_at?: string };
        Update: Partial<PartD>;
        Relationships: [];
      };
      incidents: {
        Row: Incident;
        Insert: Omit<
          Incident,
          "id" | "created_at" | "status" | "resolved_by" | "resolution_notes" | "resolved_at"
        > & {
          id?: string;
          created_at?: string;
          status?: IncidentStatus;
          resolved_by?: string | null;
          resolution_notes?: string | null;
          resolved_at?: string | null;
        };
        Update: Partial<Incident>;
        Relationships: [];
      };
      incident_photos: {
        Row: IncidentPhoto;
        Insert: Omit<IncidentPhoto, "id" | "uploaded_at"> & { id?: string; uploaded_at?: string };
        Update: never;
        Relationships: [];
      };
      notifications: {
        Row: AppNotification;
        Insert: Omit<AppNotification, "id" | "created_at" | "is_read"> & {
          id?: string;
          created_at?: string;
          is_read?: boolean;
        };
        Update: Partial<AppNotification>;
        Relationships: [];
      };
      cscs_settings: {
        Row: { key: string; value: string };
        Insert: { key: string; value: string };
        Update: Partial<{ key: string; value: string }>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, "id" | "performed_at"> & { id?: string; performed_at?: string };
        Update: never;
        Relationships: [];
      };
      catering_companies: {
        Row: CateringCompany;
        Insert: Omit<CateringCompany, "id" | "created_at" | "is_active"> & {
          id?: string;
          is_active?: boolean;
        };
        Update: Partial<CateringCompany>;
        Relationships: [];
      };
      vehicles: {
        Row: VehicleRecord;
        Insert: Omit<VehicleRecord, "id" | "created_at" | "is_active"> & {
          id?: string;
          is_active?: boolean;
        };
        Update: Partial<VehicleRecord>;
        Relationships: [];
      };
      drivers: {
        Row: DriverRecord;
        Insert: Omit<DriverRecord, "id" | "created_at" | "is_active"> & {
          id?: string;
          is_active?: boolean;
        };
        Update: Partial<DriverRecord>;
        Relationships: [];
      };
      seals: {
        Row: Seal;
        Insert: Omit<Seal, "id" | "applied_at"> & { id?: string; applied_at?: string };
        Update: never;
        Relationships: [];
      };
      seal_verifications: {
        Row: SealVerification;
        Insert: Omit<SealVerification, "id" | "verified_at"> & { id?: string; verified_at?: string };
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      current_user_role: { Args: Record<string, never>; Returns: string };
      next_transaction_number: { Args: Record<string, never>; Returns: string };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
