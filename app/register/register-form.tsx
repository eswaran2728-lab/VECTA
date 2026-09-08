"use client";

import { useState } from "react";
import Link from "next/link";
import {
  TriangleAlert,
  CheckCircle2,
  Shield,
  Truck,
  Phone,
  User,
  Mail,
  Lock,
  Building,
  Tag,
  Loader2,
} from "lucide-react";

export function RegisterForm() {
  const [systemType, setSystemType] = useState<"avsec" | "caterlink">("avsec");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const formData = new FormData(e.currentTarget);
    const payload: Record<string, string> = {
      system_type: systemType,
    };

    formData.forEach((value, key) => {
      payload[key] = String(value);
    });

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        setErrorMsg(data.error ?? "Registration failed. Please check your details.");
        setIsSubmitting(false);
        return;
      }

      setSuccessMsg(data.success ?? "Registration submitted successfully!");
      setIsSubmitting(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Network error during registration.");
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {/* System Selection Tabs */}
      <div className="flex flex-col gap-1.5">
        <label className="vecta-label">Registering For</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setSystemType("avsec")}
            className={`flex items-center justify-center gap-2 rounded-lg border py-2.5 px-3 text-xs font-semibold transition-all duration-150 cursor-pointer ${
              systemType === "avsec"
                ? "border-primary bg-primary/15 text-primary shadow-sm shadow-primary/20"
                : "border-border/60 bg-surface/50 text-muted-foreground hover:bg-surface/80"
            }`}
          >
            <Shield className="h-4 w-4" />
            <span>VECTA (AVSEC)</span>
          </button>

          <button
            type="button"
            onClick={() => setSystemType("caterlink")}
            className={`flex items-center justify-center gap-2 rounded-lg border py-2.5 px-3 text-xs font-semibold transition-all duration-150 cursor-pointer ${
              systemType === "caterlink"
                ? "border-amber-500 bg-amber-500/15 text-amber-400 shadow-sm shadow-amber-500/20"
                : "border-border/60 bg-surface/50 text-muted-foreground hover:bg-surface/80"
            }`}
          >
            <Truck className="h-4 w-4" />
            <span>CATERLINK</span>
          </button>
        </div>
      </div>

      {/* Common Information */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div>
          <label htmlFor="name" className="vecta-label flex items-center gap-1.5">
            <User className="h-3 w-3 text-muted-foreground" />
            Full Name
          </label>
          <input
            id="name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="e.g. Ahmad bin Ali"
            required
            className="vecta-input"
          />
        </div>

        <div>
          <label htmlFor="staff_id" className="vecta-label flex items-center gap-1.5">
            <Tag className="h-3 w-3 text-muted-foreground" />
            {systemType === "avsec" ? "Staff ID" : "Driver ID / NRIC"}
          </label>
          <input
            id="staff_id"
            name="staff_id"
            type="text"
            placeholder={systemType === "avsec" ? "AA-10293" : "DRV-1029 / 950101-14-1234"}
            required
            className="vecta-input"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
        <div>
          <label htmlFor="email" className="vecta-label flex items-center gap-1.5">
            <Mail className="h-3 w-3 text-muted-foreground" />
            Email Address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            placeholder={systemType === "avsec" ? "name@airasia.com" : "driver@company.com"}
            required
            className="vecta-input"
          />
        </div>

        <div>
          <label htmlFor="phone" className="vecta-label flex items-center gap-1.5">
            <Phone className="h-3 w-3 text-muted-foreground" />
            Phone Number
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            placeholder="+60 12-345 6789"
            required
            className="vecta-input"
          />
        </div>
      </div>

      <div>
        <label htmlFor="password" className="vecta-label flex items-center gap-1.5">
          <Lock className="h-3 w-3 text-muted-foreground" />
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="Minimum 8 characters"
          required
          minLength={8}
          className="vecta-input tracking-widest"
        />
      </div>

      {/* Role & Department Specific Questions */}
      <div className="my-1 border-t border-border/50 pt-3">
        {systemType === "avsec" ? (
          <div className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-primary">
              <Shield className="h-3.5 w-3.5" />
              <span>VECTA Operational Hierarchy</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="ops_group" className="vecta-label">
                  Department / Branch
                </label>
                <select id="ops_group" name="ops_group" className="vecta-input">
                  <option value="operation_avsec">OPERATION AVSEC</option>
                  <option value="ifc_avsec">IFC AVSEC</option>
                </select>
              </div>

              <div>
                <label htmlFor="avsec_role" className="vecta-label">
                  Hierarchy Rank / Level
                </label>
                <select id="avsec_role" name="avsec_role" className="vecta-input">
                  <optgroup label="Shift Operational Ranks">
                    <option value="DSE">DSE — Duty Security Executive</option>
                    <option value="SO">SO — Station Officer</option>
                    <option value="ASO">ASO — Airport Security Officer</option>
                  </optgroup>
                  <optgroup label="Command & Oversight (HQ)">
                    <option value="ENFORCEMENT">ENFORCEMENT</option>
                    <option value="MANAGEMENT">MANAGEMENT</option>
                    <option value="ADMIN">ADMIN</option>
                  </optgroup>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="team" className="vecta-label">
                  Shift Working Team
                </label>
                <select id="team" name="team" className="vecta-input">
                  <option value="ALPHA">Team ALPHA</option>
                  <option value="BRAVO">Team BRAVO</option>
                  <option value="CHARLIE">Team CHARLIE</option>
                  <option value="DELTA">Team DELTA</option>
                  <option value="HQ">HQ / Command (Non-Shift)</option>
                </select>
              </div>

              <div>
                <label htmlFor="station" className="vecta-label">
                  Base Station
                </label>
                <select id="station" name="station" className="vecta-input">
                  <option value="KUL - MAA">KUL — Kuala Lumpur (MAA)</option>
                  <option value="BKI">BKI — Kota Kinabalu</option>
                  <option value="PEN">PEN — Penang</option>
                  <option value="JHB">JHB — Johor Bahru</option>
                  <option value="KCH">KCH — Kuching</option>
                </select>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <Truck className="h-3.5 w-3.5" />
              <span>CATERLINK Driver Details</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label htmlFor="driver_type" className="vecta-label">
                  Driver Classification
                </label>
                <select id="driver_type" name="driver_type" className="vecta-input">
                  <option value="driver_ifc">IFC DRIVER (AirAsia Internal)</option>
                  <option value="driver_vendor">THIRD PARTY DRIVER (Vendor)</option>
                </select>
              </div>

              <div>
                <label htmlFor="vehicle_plate" className="vecta-label">
                  Vehicle Plate Number
                </label>
                <input
                  id="vehicle_plate"
                  name="vehicle_plate"
                  type="text"
                  placeholder="e.g. WXX 1234"
                  className="vecta-input uppercase"
                />
              </div>
            </div>

            <div>
              <label htmlFor="vendor_company" className="vecta-label flex items-center gap-1.5">
                <Building className="h-3 w-3 text-muted-foreground" />
                Catering / Vendor Company
              </label>
              <input
                id="vendor_company"
                name="vendor_company"
                type="text"
                placeholder="e.g. Brahim's SATS Food Services / Pos Aviation"
                className="vecta-input"
              />
            </div>
          </div>
        )}
      </div>

      {errorMsg ? (
        <p role="alert" className="flex items-center gap-1.5 text-xs text-brand">
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" />
          {errorMsg}
        </p>
      ) : null}

      {successMsg ? (
        <div className="flex flex-col gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-xs text-emerald-300">
          <div className="flex items-center gap-1.5 font-semibold">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
            <span>Registration Submitted!</span>
          </div>
          <p className="leading-relaxed text-foreground/90">{successMsg}</p>
          <Link
            href="/login"
            className="mt-1 font-semibold text-primary underline underline-offset-4 hover:text-primary/80"
          >
            Return to Sign In ➔
          </Link>
        </div>
      ) : (
        <button
          type="submit"
          disabled={isSubmitting}
          style={{ touchAction: "manipulation" }}
          className="vecta-btn-primary mt-2 active:scale-[0.98] transition-transform cursor-pointer flex items-center justify-center gap-2"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-primary-foreground" />
              <span>Submitting Registration…</span>
            </>
          ) : (
            <span>Submit Registration for Approval</span>
          )}
        </button>
      )}
    </form>
  );
}
