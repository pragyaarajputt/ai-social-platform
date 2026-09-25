import type { ReactNode } from "react";

export function AuthCard({ title, subtitle, children, footer }: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="w-full max-w-sm">
      <div className="rounded-2xl border border-neutral-200 p-6 shadow-sm dark:border-neutral-800">
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-neutral-500">{subtitle}</p> : null}
        <div className="mt-6">{children}</div>
      </div>
      {footer ? <div className="mt-4 text-center text-sm text-neutral-500">{footer}</div> : null}
    </div>
  );
}
