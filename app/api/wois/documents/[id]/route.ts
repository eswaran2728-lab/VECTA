import { handleWoisDocument, WOIS_PRIVATE_DIR } from "@/lib/wois/documents";
import { getWoisEligibility } from "@/lib/wois/eligibility";

export const dynamic = "force-dynamic";

/**
 * WOIS source document download. Authorization (authenticated, approved profile, active Malaysia-AOC assignment) is decided by the
 * same database function as WOIS chat and history; the id is matched against a fixed allowlist and never used as a path.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleWoisDocument(id, { eligibility: getWoisEligibility, root: WOIS_PRIVATE_DIR });
}
