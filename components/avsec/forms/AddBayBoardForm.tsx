"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { AIRCRAFT_TYPES } from "@/lib/avsec/reference-data";
import { addBayBoardEntry } from "@/lib/avsec/reports/actions";
import { TextField, SelectField, FieldRow } from "@/components/avsec/forms/fields";
import { combineDateTimeMY } from "@/lib/avsec/datetime";

interface UIValues {
  reg_no: string;
  aircraft_type: string;
  bay: string;
  date: string;
  time: string;
}

export function AddBayBoardForm({ station }: { station: string }) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const now = new Date();
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<UIValues>({
    defaultValues: {
      reg_no: "",
      aircraft_type: "",
      bay: "",
      date: now.toISOString().slice(0, 10),
      time: now.toTimeString().slice(0, 5),
    },
  });

  const onSubmit = handleSubmit(async (v) => {
    setSubmitting(true);
    const res = await addBayBoardEntry({
      station,
      reg_no: v.reg_no,
      aircraft_type: v.aircraft_type || undefined,
      bay: v.bay,
      on_ground_since: combineDateTimeMY(v.date, v.time),
    });
    setSubmitting(false);
    if (res.ok) {
      reset();
      setOpen(false);
    } else {
      alert(res.error);
    }
  });

  if (!open) {
    return (
      <button className="btn-primary w-full" onClick={() => setOpen(true)}>
        + Log aircraft on ground
      </button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card p-4 space-y-4">
      <FieldRow>
        <TextField name="reg_no" register={register} label="Reg No" required error={errors.reg_no} />
        <SelectField name="aircraft_type" register={register} label="Aircraft Type" options={AIRCRAFT_TYPES} error={errors.aircraft_type} />
      </FieldRow>
      <TextField name="bay" register={register} label="Bay" required error={errors.bay} />
      <FieldRow>
        <TextField name="date" type="date" register={register} label="Arrival Date" required error={errors.date as never} />
        <TextField name="time" type="time" register={register} label="Arrival Time" required error={errors.time as never} />
      </FieldRow>
      <div className="flex gap-2">
        <button type="button" className="btn-secondary flex-1" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="btn-primary flex-1" disabled={submitting}>
          {submitting ? "Saving…" : "Add to Bay Board"}
        </button>
      </div>
    </form>
  );
}
