import type { NextConfig } from "next";

// Where the Express API runs. Server-side only: the browser always calls /api/v1 on this site.
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // The dev server only accepts requests from localhost by default. Allow Cloudflare quick tunnels,
  // used to test Instagram/Facebook login locally (Meta only redirects to HTTPS). Dev only.
  allowedDevOrigins: ["*.trycloudflare.com"],
  // Same-origin API calls: the refresh cookie stays first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
