"use client";

import { useEffect, useState } from "react";
import { PageLoading } from "@/components/auth/RequireAuth";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { useWorkspace } from "@/components/workspace/WorkspaceProvider";
import { ApiError } from "@/lib/api";
import { getBrandVoice, saveBrandVoice, type BrandVoice } from "@/lib/ai";
import { canManageAccounts } from "@/lib/workspaces";

type Fields = Omit<BrandVoice, "updatedAt">;
const EMPTY: Fields = { tone: "", audience: "", dos: "", donts: "", samplePost: "" };

const FIELDS: { key: keyof Fields; label: string; hint: string; max: number; rows: number; placeholder: string }[] = [
  { key: "tone", label: "Tone", hint: "How the brand sounds.", max: 200, rows: 2, placeholder: "Warm, witty and down-to-earth" },
  { key: "audience", label: "Audience", hint: "Who the posts are for.", max: 300, rows: 2, placeholder: "Young professionals in Pune who love good coffee" },
  { key: "dos", label: "Always", hint: "Words, phrases or habits to use.", max: 1000, rows: 3, placeholder: "Mention our neighbourhood. Use 1–2 emoji. End with a question." },
  { key: "donts", label: "Avoid", hint: "Words or styles to stay away from.", max: 1000, rows: 3, placeholder: "No exclamation marks. Never say 'cheap'." },
  { key: "samplePost", label: "Sample post", hint: "A caption that sounds just right. AI will match its style.", max: 2200, rows: 5, placeholder: "" },
];

/** The workspace's brand voice, used in every AI suggestion. Owners and admins can edit it. */
export function BrandVoiceForm() {
  const { workspace } = useWorkspace();
  const workspaceId = workspace?.id;
  const [loaded, setLoaded] = useState<{ workspaceId: string; fields: Fields } | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    getBrandVoice(workspaceId).then(
      (voice) => {
        if (!active) return;
        const values = voice ? { tone: voice.tone ?? "", audience: voice.audience ?? "", dos: voice.dos ?? "", donts: voice.donts ?? "", samplePost: voice.samplePost ?? "" } : EMPTY;
        setLoaded({ workspaceId, fields: values });
        setFields(values);
      },
      (err: unknown) => {
        if (!active) return;
        setLoaded({ workspaceId, fields: EMPTY });
        setMessage({ tone: "error", text: err instanceof ApiError ? err.message : "Couldn't load the brand voice." });
      },
    );
    return () => {
      active = false;
    };
  }, [workspaceId]);

  if (!workspace || loaded?.workspaceId !== workspace.id) return <PageLoading />;
  const canEdit = canManageAccounts(workspace.role);
  const changed = (Object.keys(fields) as (keyof Fields)[]).some((k) => (fields[k] ?? "").trim() !== (loaded.fields[k] ?? "").trim());

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      const voice = await saveBrandVoice(workspace!.id, fields);
      const values = voice ? { tone: voice.tone ?? "", audience: voice.audience ?? "", dos: voice.dos ?? "", donts: voice.donts ?? "", samplePost: voice.samplePost ?? "" } : EMPTY;
      setLoaded({ workspaceId: workspace!.id, fields: values });
      setFields(values);
      setMessage({ tone: "success", text: voice ? "Brand voice saved. AI suggestions will use it from now on." : "Brand voice cleared." });
    } catch (err) {
      const text = err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.message) : "Couldn't save. Try again.";
      setMessage({ tone: "error", text });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Brand voice</h1>
      <p className="mt-2 text-sm text-neutral-500">
        Describe how {workspace.name} sounds. Every AI suggestion in this workspace follows it. All fields are optional.
      </p>
      {!canEdit ? (
        <div className="mt-4">
          <Alert tone="info">Only workspace owners and admins can change the brand voice.</Alert>
        </div>
      ) : null}

      <form
        className="mt-6 flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {FIELDS.map((f) => {
          const value = fields[f.key] ?? "";
          return (
            <div key={f.key} className="flex flex-col gap-1.5">
              <label htmlFor={`voice-${f.key}`} className="text-sm font-medium">
                {f.label}
              </label>
              <textarea
                id={`voice-${f.key}`}
                value={value}
                onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))}
                rows={f.rows}
                maxLength={f.max}
                readOnly={!canEdit}
                placeholder={f.placeholder}
                aria-describedby={`voice-${f.key}-hint`}
                className="rounded-lg border border-neutral-300 bg-transparent p-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 read-only:opacity-70 dark:border-neutral-700"
              />
              <p id={`voice-${f.key}-hint`} className="flex justify-between text-xs text-neutral-500">
                <span>{f.hint}</span>
                <span>
                  {value.length} / {f.max}
                </span>
              </p>
            </div>
          );
        })}

        {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
        {canEdit ? (
          <div className="w-40">
            <Button type="submit" loading={saving} disabled={!changed}>
              Save
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
