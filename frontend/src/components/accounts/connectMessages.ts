/** Messages for the ?connected= / ?error= query the backend adds when it redirects back after OAuth. */
export function connectResultMessage(
  params: URLSearchParams,
  platformName: (slug: string) => string,
): { tone: "success" | "error"; text: string } | null {
  const connected = params.get("connected");
  if (connected) {
    const count = Number(params.get("count") ?? 1);
    const elsewhere = Number(params.get("elsewhere") ?? 0);
    const skipped = elsewhere
      ? ` ${elsewhere} more ${elsewhere === 1 ? "is" : "are"} already connected to another workspace; disconnect ${elsewhere === 1 ? "it" : "them"} there to connect ${elsewhere === 1 ? "it" : "them"} here.`
      : "";
    if (connected === "facebook") return { tone: "success", text: `${count === 1 ? "Facebook Page connected." : `${count} Facebook Pages connected.`}${skipped}` };
    if (connected === "linkedin") return { tone: "success", text: `LinkedIn profile connected. LinkedIn access lasts 60 days; renew it from this page before then.${skipped}` };
    return { tone: "success", text: `${platformName(connected)} account connected.${skipped}` };
  }

  const error = params.get("error");
  if (!error) return null;
  const name = platformName(params.get("platform") ?? "");
  switch (error) {
    case "cancelled":
      return { tone: "error", text: `${name} connection was cancelled. Nothing was changed.` };
    case "invalid_state":
      return { tone: "error", text: "That connection attempt expired or was already used. Please try again." };
    case "unsupported_account":
      return {
        tone: "error",
        text:
          name === "Instagram"
            ? "Only Instagram Business or Creator accounts can be connected. In the Instagram app, go to Settings → Account type and tools → Switch to professional account, then try again."
            : `This type of ${name} account can't be connected.`,
      };
    case "connected_elsewhere":
      return {
        tone: "error",
        text: `This ${name} account is already connected to another workspace. An account can be connected to one workspace at a time: disconnect it there first.`,
      };
    case "no_accounts":
      return {
        tone: "error",
        text: "No Facebook Page was connected. In Facebook's window, choose at least one Page where you can create posts (you need a Page role that allows it).",
      };
    default:
      return { tone: "error", text: `${name} returned an error. Please try again in a moment.` };
  }
}

export const platformDisplayName = (slug: string) =>
  ({ instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn", x: "X", bluesky: "Bluesky" })[slug.toLowerCase()] ?? (slug ? slug[0]!.toUpperCase() + slug.slice(1) : "The platform");
