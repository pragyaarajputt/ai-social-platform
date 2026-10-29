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
  if (platform === "BLUESKY") {
    return (
      <svg viewBox="0 0 24 24" className={`${className} shrink-0`} aria-hidden>
        <rect width="24" height="24" rx="5" fill="#1185FE" />
        {/* The Bluesky butterfly (Simple Icons, CC0), scaled into the square. */}
        <path
          transform="translate(5 5.5) scale(0.583)"
          d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"
          fill="#fff"
        />
      </svg>
    );
  }
  if (platform === "X") {
    return (
      <svg viewBox="0 0 24 24" className={`${className} shrink-0`} aria-hidden>
        <rect width="24" height="24" rx="5" fill="#000" />
        {/* The X mark (Simple Icons, CC0), scaled into the square. */}
        <path
          transform="translate(5.5 5.5) scale(0.54)"
          d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"
          fill="#fff"
        />
      </svg>
    );
  }
  if (platform === "LINKEDIN") {
    return (
      <svg viewBox="0 0 24 24" className={`${className} shrink-0`} aria-hidden>
        <rect width="24" height="24" rx="4" fill="#0A66C2" />
        <path d="M7.1 9.6H4.6V19h2.5V9.6zM5.9 5.2a1.45 1.45 0 1 0 0 2.9 1.45 1.45 0 0 0 0-2.9zM19.4 13.8c0-2.5-.5-4.4-3.4-4.4-1.4 0-2.3.8-2.7 1.5V9.6h-2.4V19h2.5v-4.6c0-1.2.2-2.4 1.7-2.4s1.5 1.4 1.5 2.5V19h2.5l.3-5.2z" fill="#fff" />
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
