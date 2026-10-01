import type { ReactNode } from "react";
import { LEGAL } from "@/lib/legal";

/** Layout for the Privacy Policy and Terms: readable width, simple headings. */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="mx-auto w-full max-w-2xl px-4 py-10 text-sm leading-6 text-neutral-700 dark:text-neutral-300 [&_a]:underline [&_h2]:mt-8 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:mt-1 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      <p className="text-neutral-500">Last updated: {LEGAL.lastUpdated}</p>
      {children}
    </article>
  );
}
