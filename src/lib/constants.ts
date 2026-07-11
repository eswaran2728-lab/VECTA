import type {
  DeliveryLocation,
  Direction,
  IncidentStatus,
  IncidentType,
  Role,
  SealColor,
  SealType,
  TransactionStatus,
} from "./database.types";

export const ROLE_LABELS: Record<Role, string> = {
  warehouse_pic: "Warehouse PIC",
  sra_warehouse_pic: "SRA Warehouse PIC",
  post2_avsec: "AVSEC In-flight Post (Post 2)",
  post6_avsec: "AVSEC Airport Post (Post 6)",
  receiver: "SRA / Aircraft Receiver",
  supervisor: "Supervisor",
};

export const STATUS_LABELS: Record<TransactionStatus, string> = {
  CREATED: "Created — awaiting checkpoint",
  INFLIGHT_POST_APPROVED: "In-flight Post approved",
  AIRPORT_POST_APPROVED: "Airport Post approved",
  COMPLETED: "Completed",
  ESCALATED: "Escalated",
};

export const STATUS_COLORS: Record<TransactionStatus, string> = {
  CREATED: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  INFLIGHT_POST_APPROVED: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  AIRPORT_POST_APPROVED: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  ESCALATED: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
};

export const DIRECTION_LABELS: Record<Direction, string> = {
  OUTBOUND: "Outbound — Departure",
  INBOUND: "Inbound — Arrival",
};

/** Matches the physical truck seal colors: blue outbound, green inbound. */
export const DIRECTION_COLORS: Record<Direction, string> = {
  OUTBOUND: "bg-blue-600 text-white dark:bg-blue-500",
  INBOUND: "bg-green-600 text-white dark:bg-green-500",
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
  EXPIRED_PASS: "Expired Airport Pass",
  WRONG_SEAL_COLOR: "Wrong Seal Color",
  TIMEOUT: "Transaction Timeout",
  OTHER: "Other",
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  OPEN: "Open",
  UNDER_REVIEW: "Under Review",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
};

export const INCIDENT_STATUS_COLORS: Record<IncidentStatus, string> = {
  OPEN: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  UNDER_REVIEW: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  RESOLVED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  CLOSED: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

export const SEAL_TYPE_LABELS: Record<SealType, string> = {
  TRUCK_SEAL: "Truck Seal",
  TROLLEY: "Trolley Seal",
  OTHER: "Other",
};

export const SEAL_COLOR_LABELS: Record<SealColor, string> = {
  BLUE: "Blue",
  GREEN: "Green",
  OTHER: "Other",
};

export const SEAL_COLOR_BADGES: Record<SealColor, string> = {
  BLUE: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  GREEN: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200",
  OTHER: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200",
};

/** Truck seal color required per direction (physical AirAsia process). */
export const DIRECTION_TRUCK_SEAL_COLOR: Record<Direction, SealColor> = {
  OUTBOUND: "BLUE",
  INBOUND: "GREEN",
};

export const ALL_ROLES: Role[] = [
  "warehouse_pic",
  "sra_warehouse_pic",
  "post2_avsec",
  "post6_avsec",
  "receiver",
  "supervisor",
];
