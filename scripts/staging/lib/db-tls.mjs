import fs from "node:fs";

// Certificate- and hostname-verified TLS for hosted Postgres connections.
// Uses the OS/Node trusted CA chain, plus an optional official Supabase CA
// file named by VECTA_DB_CA_CERT_PATH. Never disables verification; never
// reads the certificate into any log.
export function buildVerifiedClientConfig(dbUrl) {
  const url = new URL(dbUrl);
  // pg-connection-string would otherwise let sslmode in the URL override the
  // explicit ssl option below.
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);

  const ssl = { rejectUnauthorized: true };
  const caPath = process.env.VECTA_DB_CA_CERT_PATH;
  if (caPath) {
    if (!fs.existsSync(caPath)) throw new Error("VECTA_DB_CA_CERT_PATH is set but the file does not exist.");
    ssl.ca = fs.readFileSync(caPath, "utf8");
  }
  return { connectionString: url.toString(), ssl, usedExplicitCa: Boolean(caPath) };
}

export function describeTlsError(err) {
  const code = err && err.code ? String(err.code) : "UNKNOWN";
  return `TLS/connection error code=${code} message=${String(err && err.message).replace(/postgres(ql)?:\/\/[^@\s]+@/g, "postgres://[REDACTED]@")}`;
}
