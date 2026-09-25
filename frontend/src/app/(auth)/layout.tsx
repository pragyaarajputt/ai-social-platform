import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 items-start justify-center px-4 py-16">{children}</div>;
}
