# Deploying PostDrip

Two ways to run PostDrip online:

- **[Vercel](#option-a-vercel-free) (free):** website and API as one Vercel project (services), database
  on Neon, and an outside scheduler instead of the always-on worker. Good for a demo or portfolio. Vercel's free plan is for
  non-commercial use.
- **[Railway](#option-b-railway) (~$5–10/month):** everything on one host, including the real worker.
  Better for a live product.

## Option A: Vercel (free)

One Vercel project runs both parts as **services** (configured in the root `vercel.json`), on one
address:

| Service | Folder | Public path | Notes |
|---|---|---|---|
| `api` | `backend/` | `/api/*` (receives the full path, e.g. `/api/v1/...`) | Express, started from `src/server.ts`; each deploy applies database migrations (`npm run db:deploy`) |
| `web` | `frontend/` | everything else | Next.js |

| Also | Where | Notes |
|---|---|---|
| Database | Neon Postgres (Vercel Marketplace) | Free; sleeps when idle |
| Background jobs | cron-job.org calls `POST /api/v1/internal/run-jobs` every minute | Publishing on every call, maintenance at most hourly |

The browser only ever calls `/api/v1` on the same address, so login cookies stay first-party and no
`API_URL` is needed on Vercel. Every push to `main` redeploys.

### A1. Accounts

Sign in with GitHub at [vercel.com](https://vercel.com) (Hobby plan) and allow access to **only** the
`ai-social-platform` repository. Create a free account at [cron-job.org](https://cron-job.org).

### A2. Create the project

1. Vercel → **Add New → Project → ai-social-platform**. Name it (e.g. `postdrip`). Leave **Root
   Directory** as the repository root: Vercel reads the services from `vercel.json`.
2. **Storage → Create / Connect Database → Neon** (free), connected to this project. This adds
   `DATABASE_URL` (pooled, used by the app) and `DATABASE_URL_UNPOOLED` (direct, used by migrations).
3. **Settings → Environment Variables**: the same list as Railway's `api`/`worker` (step 3 of
   Option B), except:
   - leave out `DATABASE_URL` and `PORT` (Neon and Vercel provide them),
   - `TRUST_PROXY=true` (Vercel's edge sets the visitor's address),
   - add `CRON_SECRET=<new: 32+ random characters>`,
   - `APP_URL` and `CORS_ORIGIN` are the project's address, e.g. `https://postdrip.vercel.app`
     (shown after the first deploy; set them and redeploy).
4. **Deploy**. Open the address: the home page loads, and signing up sends the verification email.

### A3. The scheduler

cron-job.org → **Create cronjob**:
- URL: `https://<project address>/api/v1/internal/run-jobs`, method **POST**
- Schedule: every minute
- Advanced → Headers: `Authorization: Bearer <CRON_SECRET>`

Each call publishes posts that are due and, once an hour, runs maintenance (token refresh, health
checks, warnings, analytics). A call that runs maintenance can take longer than cron-job.org's timeout;
that's harmless (the work finishes on Vercel).

### A4. Platforms and checks

Use the project address everywhere a redirect or link is needed (section 6 of Option B):
`https://<project address>/api/v1/integrations/<platform>/callback`,
`https://<project address>/api/v1/auth/google/callback`, `/privacy`, `/terms`. Then run the go-live
checks (section 7 of Option B).

Limits on the free setup: scheduled posts go out within about a minute of their time; a single request
has a time limit (long video uploads continue on the next scheduler call); the first request after Neon
has been idle is a little slower.

## Option B: Railway

PostDrip runs as three services and a database. Only the website is public: it forwards `/api/v1/*`
to the API over Railway's private network (see `frontend/next.config.ts`), so login cookies stay
first-party and the API and database are never exposed.

| Service | Folder | What it does | Public |
|---|---|---|---|
| `web` | `frontend/` | Next.js site; proxies `/api/v1` to `api` | yes, your domain |
| `api` | `backend/` | Express API; runs database migrations before each deploy | no |
| `worker` | `backend/` | Publishes scheduled posts, renews logins, collects analytics (must always run) | no |
| `Postgres` | — | Railway's PostgreSQL | no |

Every push to `main` redeploys the services whose folder changed.

## 1. Create the project

1. [railway.com](https://railway.com): sign in with GitHub, choose the Hobby plan. When Railway asks
   for GitHub access, allow **only** the `ai-social-platform` repository.
2. **New Project → Deploy PostgreSQL**. Rename nothing: the service is called `Postgres`.
3. In the same project, **Create → GitHub Repo → ai-social-platform** three times, and rename the
   services `web`, `api` and `worker`.

## 2. Configure each service (Settings tab)

**`api`**
- Source → Root Directory: `/backend`
- Build → Watch Paths: `/backend/**`
- Build → Custom Build Command: `npm run build`
- Deploy → Pre-deploy Command: `npm run db:deploy` (applies new database migrations)
- Deploy → Custom Start Command: `npm start`
- Deploy → Healthcheck Path: `/health`
- Networking: no public domain.

**`worker`**
- Source → Root Directory: `/backend`
- Build → Watch Paths: `/backend/**`
- Build → Custom Build Command: `npm run build`
- Deploy → Custom Start Command: `npm run worker:start`
- Networking: no public domain.

**`web`**
- Source → Root Directory: `/frontend`
- Build → Watch Paths: `/frontend/**`
- Build → Custom Build Command: `npm run build`
- Deploy → Custom Start Command: `npm start`
- Networking → **Generate Domain** now; add your custom domain later (step 5).

## 3. Variables (Variables tab)

Type secrets into Railway yourself. Never commit them or paste them anywhere else.

**`web`**

```
API_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:4000
```

`API_URL` is read when the site is built (it becomes the `/api/v1` rewrite), so redeploy `web` after changing it.

**`api` and `worker`** — the same values on both. Use Railway's **Shared Variables** (Project
Settings), then add them to both services:

```
NODE_ENV=production
PORT=4000
DATABASE_URL=${{Postgres.DATABASE_URL}}
APP_URL=https://<your domain>
CORS_ORIGIN=https://<your domain>
TRUST_PROXY=2

JWT_ACCESS_SECRET=<new: 64 random bytes, base64url>
TOKEN_ENCRYPTION_KEY=<new: 32 random bytes, base64>

SMTP_URL=smtps://resend:<Resend API key>@smtp.resend.com:465
EMAIL_FROM=PostDrip <no-reply@<your domain>>

CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CLOUDINARY_FOLDER=postdrip

AI_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_FREE_TIER=false
AI_MAX_RETRIES=1

INSTAGRAM_APP_ID=...
INSTAGRAM_APP_SECRET=...
INSTAGRAM_REDIRECT_URI=https://<your domain>/api/v1/integrations/instagram/callback

# When set up:
# FACEBOOK_APP_ID / FACEBOOK_APP_SECRET / FACEBOOK_CONFIG_ID
# FACEBOOK_REDIRECT_URI=https://<your domain>/api/v1/integrations/facebook/callback
# LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET
# LINKEDIN_REDIRECT_URI=https://<your domain>/api/v1/integrations/linkedin/callback
# GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
# GOOGLE_REDIRECT_URI=https://<your domain>/api/v1/auth/google/callback
```

Generate the two secrets on your own computer (new ones for production, not your local ones):

```
node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"   # JWT_ACCESS_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # TOKEN_ENCRYPTION_KEY
```

Keep a private copy of `TOKEN_ENCRYPTION_KEY` (e.g. in a password manager). Without it, stored
platform logins can't be read and every account must be reconnected. To change it later, rotate
with `TOKEN_ENCRYPTION_KEYS` (see `backend/.env.example`).

With `NODE_ENV=production` the API refuses to start if `APP_URL` isn't `https://` or `CORS_ORIGIN`
is a different site, and logs warnings for a missing `SMTP_URL` or `TRUST_PROXY` and for Gemini's
free tier (where Google may use prompts to improve its products).

## 4. First deploy

Deploy `api` first (its pre-deploy step creates the database tables), then `worker` and `web`.
Check the logs:

- `api`: `API listening on …`, and no `Warning:` lines you didn't expect.
- `worker`: `[worker] started; publishing every 5s …`.
- `web`: open the generated domain, sign up, and confirm the verification email arrives.

Only run **one** copy of the app against this database while testing; a local worker must not use
the production `DATABASE_URL`.

## 5. Domain and email

1. `web` → Settings → Networking → **Custom Domain**, enter your domain, and add the DNS records
   Railway shows at your domain registrar. HTTPS is set up automatically.
2. [Resend](https://resend.com): add the domain, add its DNS records, create an API key, and set
   `SMTP_URL` / `EMAIL_FROM` as above.
3. Update `APP_URL`, `CORS_ORIGIN` and every `*_REDIRECT_URI` to the domain, and redeploy.

## 6. Point the platforms at the domain

Add each redirect URI exactly as in step 3:

- **Instagram**: Meta app → Instagram → API setup with Instagram business login → Business login
  settings → OAuth redirect URIs. Also set the Deauthorize callback URL to
  `https://<your domain>/api/v1/integrations/instagram/deauthorize` and the Data deletion request URL
  to `https://<your domain>/api/v1/integrations/instagram/data-deletion`.
- **Facebook**: Facebook Login for Business → Settings → Valid OAuth Redirect URIs; the same two
  callbacks with `facebook` in the path.
- **Meta app → App settings → Basic**: Privacy Policy URL `https://<your domain>/privacy`, Terms of
  Service URL `https://<your domain>/terms`, App domain `<your domain>`.
- **LinkedIn**: developer app → Auth → Authorized redirect URLs.
- **Google**: Google Cloud Console → Credentials → OAuth client → Authorized redirect URIs.

## 7. Go-live checks

- Sign up with a new account; verify the email; create a post with a photo.
- Connect Instagram and publish a post; schedule one a few minutes ahead and watch the `worker`
  logs publish it.
- Postgres service → **Backups**: turn on scheduled backups if your plan includes them; otherwise
  take regular `pg_dump` backups.
- Check that rate limits see visitors' addresses: in the `api` logs, sign-in rate limiting should
  not treat everyone as one address. If it does, adjust `TRUST_PROXY`.

## 8. Letting anyone connect

- **LinkedIn**: works for every LinkedIn member once the app has its two products.
- **Instagram and Facebook**: until Meta approves the app, only people with a role on the app
  (testers) can connect. Switch the app to Live, complete Business Verification, and submit App
  Review for the permissions PostDrip uses, with a screen recording of each one in use.
