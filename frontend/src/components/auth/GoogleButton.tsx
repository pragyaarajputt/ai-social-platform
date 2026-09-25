"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";

const START_URL = "/api/v1/auth/google";

export function GoogleButton() {
  const [checking, setChecking] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  async function start() {
    setChecking(true);
    try {
      // When Google is configured the server answers with a redirect; when it isn't, with 501.
      const res = await fetch(START_URL, { redirect: "manual", credentials: "same-origin" });
      if (res.type === "opaqueredirect") {
        // A full page load is required: this is an API route that redirects to Google, not a Next.js page.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign(START_URL);
        return;
      }
      setUnavailable(true);
    } catch {
      setUnavailable(true);
    }
    setChecking(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <Button type="button" variant="secondary" loading={checking} onClick={start}>
        Continue with Google
      </Button>
      {unavailable ? <Alert tone="info">Google sign-in isn&apos;t set up yet. Use your email and password.</Alert> : null}
    </div>
  );
}
