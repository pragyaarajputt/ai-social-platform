import { platformName } from "@/lib/platforms";
import type { SocialPlatform } from "@/lib/workspaces";

/** A small platform mark next to account names. Decorative: the name is always shown alongside. */
export function PlatformIcon({ platform, className = "h-4 w-4" }: { platform: SocialPlatform; className?: string }) {
  if (platform === "FACEBOOK") {
    return (
      <svg viewBox="0 0 24 24" className={`${className} shrink-0`} aria-hidden>
        <circle cx="12" cy="12" r="12" fill="#0866FF" />
        <path d="M13.4 19v-6h2l.3-2.4h-2.3V9.1c0-.7.2-1.1 1.2-1.1h1.2V5.9c-.2 0-1-.1-1.8-.1-1.8 0-3 1.1-3 3.1v1.7h-2V13h2v6h2.4z" fill="#fff" />
      </svg>
    );
  }
  if (platform === "INSTAGRAM") {
    return (
      <svg viewBox="0 0 24 24" className={`${className} shrink-0`} aria-hidden>
        <defs>
          <linearGradient id="ig-grad" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#FEDA75" />
            <stop offset="0.35" stopColor="#FA7E1E" />
            <stop offset="0.65" stopColor="#D62976" />
            <stop offset="1" stopColor="#4F5BD5" />
          </linearGradient>
        </defs>
        <rect width="24" height="24" rx="6" fill="url(#ig-grad)" />
        <rect x="6" y="6" width="12" height="12" rx="3.5" fill="none" stroke="#fff" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="3" fill="none" stroke="#fff" strokeWidth="1.8" />
        <circle cx="16.2" cy="7.8" r="1" fill="#fff" />
      </svg>
    );
  }
  return (
    <span className={`${className} inline-flex shrink-0 items-center justify-center rounded bg-neutral-400 text-[9px] font-bold text-white`} aria-hidden>
      {platformName(platform)[0]}
    </span>
  );
}
