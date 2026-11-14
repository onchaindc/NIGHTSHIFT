"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("nightshift-theme");
    const prefers = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = saved === "dark" || (!saved && prefers);
    setDark(isDark);
    document.documentElement.classList.toggle("dark", isDark);
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    localStorage.setItem("nightshift-theme", next ? "dark" : "light");
  };

  return (
    <button
      onClick={toggle}
      className="btn-quiet !min-h-8 !px-2.5 !text-[12px]"
      aria-label={dark ? "Switch to light" : "Switch to night"}
    >
      {dark ? <Sun size={14} aria-hidden /> : <Moon size={14} aria-hidden />}
      {/* Icon only on a phone: the label would crowd the brand and Ask in a 56px bar. */}
      <span className="ml-1.5 hidden sm:inline">{dark ? "Light" : "Night"}</span>
    </button>
  );
}
