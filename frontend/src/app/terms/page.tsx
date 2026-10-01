import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal/LegalPage";
import { LEGAL } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  const { product, operator, contactEmail, country } = LEGAL;
  return (
    <LegalPage title="Terms of Service">
      <p>
        These terms apply when you use {product}, run by {operator} (&quot;we&quot;). By creating an account you agree to them. How we
        handle your data is described in our <Link href="/privacy">Privacy Policy</Link>.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be at least 16 and give accurate information.</li>
        <li>Keep your password safe. You&apos;re responsible for what happens in your account and the workspaces you manage.</li>
        <li>Workspace owners and admins decide who joins their workspace and what each member can do.</li>
      </ul>

      <h2>Connected social accounts</h2>
      <ul>
        <li>Only connect accounts you own or are authorized to manage.</li>
        <li>
          When you connect an account, you let {product} publish the posts you or your team create and schedule, and read the data
          described in the Privacy Policy. You can disconnect at any time.
        </li>
        <li>
          Your use of Instagram, Facebook and LinkedIn is also governed by their own terms and policies. Platforms can change or
          limit their services, which can affect what {product} can do.
        </li>
      </ul>

      <h2>Your content</h2>
      <ul>
        <li>You keep ownership of your content. You give us permission to store, process and publish it only to provide the service.</li>
        <li>
          You&apos;re responsible for what you publish. Don&apos;t use {product} for spam, or for content that is illegal, infringes
          others&apos; rights, or breaks the platforms&apos; rules.
        </li>
        <li>
          AI suggestions can be wrong or unsuitable. Review them before publishing; you decide what goes out under your name.
        </li>
      </ul>

      <h2>Acceptable use</h2>
      <p>
        Don&apos;t try to break, overload, or get unauthorized access to {product} or other people&apos;s data, and don&apos;t use it
        to get around the platforms&apos; limits. We may suspend accounts that do.
      </p>

      <h2>The service</h2>
      <ul>
        <li>
          We work to keep {product} running and posts publishing on time, but we can&apos;t guarantee it: platforms, networks and
          our providers can fail. Keep your own copies of important content.
        </li>
        <li>We may change or discontinue features. If we shut {product} down, we&apos;ll give reasonable notice where we can.</li>
      </ul>

      <h2>Ending</h2>
      <p>
        You can stop using {product} and ask us to delete your account at any time (see{" "}
        <Link href="/privacy#data-deletion">Deleting your data</Link>). We may end or suspend access if these terms are broken.
      </p>

      <h2>Liability</h2>
      <p>
        {product} is provided &quot;as is&quot;. To the extent the law allows, we aren&apos;t liable for indirect losses, lost profits,
        or posts that fail or are delayed. Nothing in these terms limits rights you have that can&apos;t be limited by law.
      </p>

      <h2>General</h2>
      <p>
        These terms are governed by the laws of {country}. If we change them we&apos;ll update the date above, and tell you by email for
        significant changes. Questions: <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
      </p>
    </LegalPage>
  );
}
