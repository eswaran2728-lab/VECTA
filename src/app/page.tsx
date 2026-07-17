import { redirect } from "next/navigation";
import { getCurrentProfile } from "@/lib/auth";

export default async function RootPage() {
  const profile = await getCurrentProfile();
  if (!profile) redirect("/login");
  if (!profile.name || !profile.station || !profile.team) redirect("/profile-setup");
  redirect("/home");
}
