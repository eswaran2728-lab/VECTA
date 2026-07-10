import type {
  DeliveryLocation,
  Direction,
  IncidentType,
  Role,
  TransactionStatus,
} from "./database.types";

export const ROLE_LABELS: Record<Role, string> = {
  warehouse_pic: "Warehouse PIC",
  post2_avsec: "AVSEC Post 2",
  post6_avsec: "AVSEC Post 6",
  receiver: "SRA / Aircraft Receiver",
  supervisor: "Supervisor",
};

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  CREATED: "Created (awaiting Post 2)",
  POST2_APPROVED: "Post 2 approved (awaiting Post 6)",
  POST6_APPROVED: "Post 6 approved (awaiting delivery)",
  COMPLETED: "Completed",
  ESCALATED: "Escalated",
};

export const STATUS_COLORS: Record<TransactionStatus, string> = {
  CREATED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  POST2_APPROVED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  POST6_APPROVED: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  ESCALATED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

export const DIRECTION_LABELS: Record<Direction, string> = {
  WAREHOUSE_TO_AIRCRAFT: "Warehouse → Aircraft",
  AIRCRAFT_TO_WAREHOUSE: "Aircraft → Warehouse",
};

export const DELIVERY_LOCATION_LABELS: Record<DeliveryLocation, string> = {
  SRA_WAREHOUSE: "SRA Warehouse",
  AIRCRAFT: "Aircraft",
};

export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  BROKEN_SEAL: "Broken Seal",
  SEAL_MISMATCH: "Seal Mismatch",
  UNAUTHORIZED_DRIVER: "Unauthorized Driver",
  UNAUTHORIZED_VEHICLE: "Unauthorized Vehicle",
  OTHER: "Other",
};

/** Which role completes which checkpoint, and from which status. */
export const CHECKPOINTS = {
  part_b: { role: "post2_avsec" as Role, requiredStatus: "CREATED" as TransactionStatus, label: "Part B — AVSEC Post 2" },
  part_c: { role: "post6_avsec" as Role, requiredStatus: "POST2_APPROVED" as TransactionStatus, label: "Part C — AVSEC Post 6" },
  part_d: { role: "receiver" as Role, requiredStatus: "POST6_APPROVED" as TransactionStatus, label: "Part D — Delivery" },
};

export const ALL_ROLES: Role[] = [
  "warehouse_pic",
  "post2_avsec",
  "post6_avsec",
  "receiver",
  "supervisor",
];
