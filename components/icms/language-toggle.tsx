import { toggleLanguage } from "@/lib/icms/actions/language";
import type { Lang } from "@/lib/icms/i18n";

/** EN ⇄ BM toggle; server action persists to cookie + user profile. */
export function LanguageToggle({ lang }: { lang: Lang }) {
  return (
    <form action={toggleLanguage}>
      <button
        type="submit"
        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md px-2 py-1.5 text-xs font-bold text-muted-foreground hover:bg-accent hover:text-foreground lg:min-h-[28px] lg:min-w-0"
        aria-label="Toggle language English / Bahasa Melayu"
      >
        {lang === "en" ? "BM" : "EN"}
      </button>
    </form>
  );
}
