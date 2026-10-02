import type { NextConfig } from "next";

// Where the Express API runs. Server-side only: the browser always calls /api/v1 on this site.
const apiUrl = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // The dev server only accepts requests from localhost by default. Allow tunnels (Cloudflare quick
  // tunnels, ngrok's fixed free addresses), used to test platform logins locally: Meta only redirects
  // to HTTPS. Dev only.
  allowedDevOrigins: ["*.trycloudflare.com", "*.ngrok-free.dev", "*.ngrok-free.app"],
  // Same-origin API calls: the refresh cookie stays first-party and no CORS is needed.
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${apiUrl}/api/v1/:path*` }];
  },
};

export default nextConfig;
