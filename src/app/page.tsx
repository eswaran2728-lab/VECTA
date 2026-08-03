import { redirect } from "next/navigation";
import { getCurrentProfile, landingPathForRole } from "@/lib/auth";

export default async function RootPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.name || !profile.station || !profile.team) redirect("/profile-setup");
  if (profile.status !== "approved") redirect("/pending-approval");
  redirect(landingPathForRole(profile.role));
}
