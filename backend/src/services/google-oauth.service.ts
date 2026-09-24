import { decodeIdToken, generateCodeVerifier, generateState, Google } from "arctic";
import { env } from "../config/env.js";
import { AppError } from "../utils/AppError.js";

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

const google = env.google
  ? new Google(env.google.clientId, env.google.clientSecret, env.google.redirectUri)
  : undefined;

export function assertGoogleConfigured(): void {
  client();
}

function client(): Google {
  if (!google) {
    throw new AppError(501, "NOT_CONFIGURED", "Google sign-in is not configured on this server");
  }
  return google;
}

export function createGoogleAuthRequest(): { url: string; state: string; codeVerifier: string } {
  const g = client();
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = g.createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
  return { url: url.toString(), state, codeVerifier };
}

export async function exchangeGoogleCode(code: string, codeVerifier: string): Promise<GoogleProfile> {
  const tokens = await client().validateAuthorizationCode(code, codeVerifier);
  // The ID token comes straight from Google's token endpoint over TLS, so decoding without
  // re-verifying the signature is allowed by OpenID Connect (Core 1.0, section 3.1.3.7).
  const claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;

  if (typeof claims.sub !== "string" || typeof claims.email !== "string") {
    throw new AppError(400, "OAUTH_FAILED", "Google did not return an email address");
  }
  return {
    sub: claims.sub,
    email: claims.email.toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: typeof claims.name === "string" ? claims.name : undefined,
  };
}
