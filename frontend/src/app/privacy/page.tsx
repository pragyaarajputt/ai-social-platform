import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy Policy" };

// Describes what the app actually does; keep it in step with the code (data stored, services used).
export default function PrivacyPage() {
  const { product, operator, contactEmail } = LEGAL;
  return (
    <LegalPage title="Privacy Policy">
      <p>
        {product} helps you write, schedule and publish posts to your social media accounts. This policy explains what we collect,
        why, who we share it with, and how to have it deleted. {product} is run by {operator} (&quot;we&quot;). Contact:{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account:</strong> email address, username, display name and a securely hashed password, or your Google
          account ID and email if you sign in with Google.
        </li>
        <li>
          <strong>Connected social accounts</strong> (Instagram, Facebook Pages, LinkedIn): the account&apos;s ID, name, username
          and profile picture, the permissions you granted, and the access tokens the platform issues. Access tokens are encrypted
          (AES-256-GCM) before they are stored.
        </li>
        <li>
          <strong>Your content:</strong> posts, captions, schedules, the photos and videos you upload, your brand voice settings,
          and your workspaces and team members.
        </li>
        <li>
          <strong>Performance numbers</strong> for connected Instagram accounts and Facebook Pages (reach, views, likes, comments,
          followers and similar), which the platforms provide so we can show you analytics.
        </li>
        <li>
          <strong>AI requests:</strong> when you use the AI writing tools, a record of the request (feature, time, usage and the
          suggestions returned) and any rating you give.
        </li>
        <li>
          <strong>Security records:</strong> sign-ins, invitations and changes to accounts and workspaces (an audit log), and
          technical data such as IP addresses used to prevent abuse.
        </li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To publish and schedule posts to the accounts you connect, only when you or your team ask us to.</li>
        <li>To show you analytics for your own accounts.</li>
        <li>To generate caption, hashtag and rewrite suggestions when you use the AI tools.</li>
        <li>To send you emails you need: email verification, password resets, team invitations and warnings about posts that may fail.</li>
        <li>To keep the service secure and working.</li>
      </ul>
      <p>We don&apos;t sell your data, don&apos;t show ads, and don&apos;t use data from Instagram, Facebook or LinkedIn for anything other than the features above.</p>

      <h2>Who we share it with</h2>
      <p>We use these services to run {product}. Each receives only what it needs:</p>
      <ul>
        <li><strong>Meta</strong> (Instagram, Facebook) and <strong>LinkedIn:</strong> the posts and media you choose to publish, sent with your permission.</li>
        <li><strong>Cloudinary:</strong> stores the photos and videos you upload.</li>
        <li>
          <strong>Google (Gemini API)</strong> or <strong>Anthropic (Claude API):</strong> the text and photos you send to the AI tools,
          to produce suggestions.
        </li>
        <li><strong>Google Sign-In:</strong> if you choose to sign in with Google.</li>
        <li><strong>Our hosting and database provider</strong> and <strong>our email provider</strong>, which run the service and deliver its emails.</li>
      </ul>
      <p>We may also disclose data if the law requires it.</p>

      <h2>Cookies</h2>
      <p>
        We use one essential cookie to keep you signed in. We don&apos;t use advertising or tracking cookies.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Your data is kept while your account is active.</li>
        <li>
          Disconnecting a social account deletes its access tokens immediately; {product} can no longer post to it or read its data.
        </li>
        <li>Deleting a workspace deletes its posts, schedules, connected accounts and analytics.</li>
        <li>
          Deleting media removes it from your library; to have the stored files erased from our storage provider too, contact us.
        </li>
      </ul>

      <h2 id="data-deletion">Deleting your data</h2>
      <ul>
        <li>
          <strong>Your whole account:</strong> email <a href={`mailto:${contactEmail}`}>{contactEmail}</a> from the address you
          signed up with. We delete your account and its data within 30 days and confirm by email.
        </li>
        <li>
          <strong>A connected account:</strong> disconnect it on the Accounts page, or remove {product} in the platform&apos;s own
          settings (for example Instagram → Settings → Apps and websites, or Facebook → Settings → Business integrations). When
          Instagram or Facebook tells us you removed the app, we delete that account&apos;s tokens automatically.
        </li>
        <li><strong>A workspace:</strong> its owner can delete it in Workspace settings.</li>
      </ul>

      <h2>Your rights</h2>
      <p>
        You can ask for a copy of your data, ask us to correct or delete it, or object to how we use it, by emailing{" "}
        <a href={`mailto:${contactEmail}`}>{contactEmail}</a>. Depending on where you live, you may also be able to complain to
        your data protection authority.
      </p>

      <h2>Security</h2>
      <p>
        Connections are encrypted (HTTPS), passwords are hashed, platform access tokens are encrypted at rest, and access inside a
        workspace is limited by role. No system is perfectly secure; if a breach affects your data we will tell you.
      </p>

      <h2>Children</h2>
      <p>{product} is not meant for anyone under 16.</p>

      <h2>Changes</h2>
      <p>
        If we change this policy we&apos;ll update the date above, and tell you by email for significant changes. See also our{" "}
        <Link href="/terms">Terms of Service</Link>.
      </p>
    </LegalPage>
  );
}
