import Link from "next/link";
import { LEGAL } from "@/lib/legal";

/** On every page: the Privacy Policy and Terms must be easy to find (Meta, LinkedIn and Google check). */
export function SiteFooter() {
  return (
    <footer className="border-t border-neutral-200 px-4 py-4 text-xs text-neutral-500 dark:border-neutral-800">
      <nav aria-label="Legal" className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-4 gap-y-1">
        <span>© {LEGAL.product}</span>
        <Link href="/privacy" className="hover:underline">
          Privacy Policy
        </Link>
        <Link href="/terms" className="hover:underline">
          Terms of Service
        </Link>
      </nav>
    </footer>
  );
}
