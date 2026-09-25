/** Messages for the ?connected= / ?error= query the backend adds when it redirects back after OAuth. */
export function connectResultMessage(
  params: URLSearchParams,
  platformName: (slug: string) => string,
): { tone: "success" | "error"; text: string } | null {
  const connected = params.get("connected");
  if (connected) return { tone: "success", text: `${platformName(connected)} account connected.` };

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
    default:
      return { tone: "error", text: `${name} returned an error. Please try again in a moment.` };
  }
}

export const platformDisplayName = (slug: string) =>
  ({ instagram: "Instagram" })[slug.toLowerCase()] ?? (slug ? slug[0]!.toUpperCase() + slug.slice(1) : "The platform");
