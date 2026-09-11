"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/icms/ui/button";

const STORAGE_KEY = "vecta-theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem("cscs-theme") || localStorage.getItem("avsec-theme");
      const isDark = stored ? stored === "dark" : true;
      setDark(isDark);
      document.documentElement.classList.toggle("dark", isDark);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
      localStorage.setItem("cscs-theme", next ? "dark" : "light");
    } catch {
      // ignore
    }
  };

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode" className="text-muted-foreground hover:text-foreground">
      {dark ? <Sun className="h-5 w-5 text-primary" /> : <Moon className="h-5 w-5" />}
    </Button>
  );
}
