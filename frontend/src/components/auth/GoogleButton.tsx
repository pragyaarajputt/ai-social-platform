"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

const START_URL = "/api/v1/auth/google";

/**
 * Starts Google sign-in, which also creates the account the first time. It's a plain navigation to the
 * API, which redirects to Google. There's no "is Google set up?" check first: on a server that has just
 * woken up that check could time out and wrongly say Google isn't available. When it really isn't, the
 * API sends the browser back to the login page with a message.
 */
export function GoogleButton({ next = "/" }: { next?: string }) {
  const [leaving, setLeaving] = useState(false);

  function start() {
    setLeaving(true);
    // A full page load: this is an API route that redirects to Google, not a Next.js page.
    window.location.assign(next === "/" ? START_URL : `${START_URL}?next=${encodeURIComponent(next)}`);
  }

  return (
    <Button type="button" variant="secondary" loading={leaving} onClick={start}>
      Continue with Google
    </Button>
  );
}
