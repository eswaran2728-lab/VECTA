import { getCurrentProfile, getCurrentUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { updateProfile } from "@/lib/profile-actions";
import { STATIONS, TEAMS } from "@/lib/reference-data";

export default async function ProfileSetupPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const profile = await getCurrentProfile();

  return (
    <main className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md card p-6">
        <h1 className="section-title mb-1">Complete your profile</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">
          This auto-fills your details on every report — Email, Name, Staff No, Station and Team.
        </p>

        {searchParams.error && (
          <p className="field-error mb-4">
            {searchParams.error === "missing" ? "All fields are required." : searchParams.error}
          </p>
        )}

        <form action={updateProfile} className="space-y-4">
          <div>
            <label className="field-label">Email</label>
            <input className="input-base" value={user.email ?? ""} disabled />
          </div>

          <div>
            <label className="field-label" htmlFor="name">
              Full name
            </label>
            <input
              id="name"
              name="name"
              required
              defaultValue={profile?.name ?? ""}
              className="input-base"
              placeholder="As per staff ID"
            />
          </div>

          <div>
            <label className="field-label" htmlFor="staff_no">
              Staff No / ID
            </label>
            <input
              id="staff_no"
              name="staff_no"
              required
              defaultValue={profile?.staff_no ?? ""}
              className="input-base"
            />
          </div>

          <div>
            <label className="field-label" htmlFor="station">
              Station
            </label>
            <select
              id="station"
              name="station"
              required
              defaultValue={profile?.station ?? ""}
              className="input-base"
            >
              <option value="" disabled>
                Select station
              </option>
              {STATIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="field-label" htmlFor="team">
              Team
            </label>
            <select
              id="team"
              name="team"
              required
              defaultValue={profile?.team ?? ""}
              className="input-base"
            >
              <option value="" disabled>
                Select team
              </option>
              {TEAMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <button type="submit" className="btn-primary w-full">
            Save and continue
          </button>
        </form>
      </div>
    </main>
  );
}
