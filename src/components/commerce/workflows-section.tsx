"use client";

/**
 * Workflows — one commercial job coordinated across multiple agents. Desk
 * steps open REAL Deal Desk files and run their FREE pre-flight (probes only,
 * nothing spent); a paid run stays parked at the desk's own human approval
 * gate and is never triggered from here. Coordination steps record assignments.
 */

import { useCallback, useEffect, useState } from "react";

import { friendlyNetworkError } from "@/lib/api/client-errors";
import { ActionError, EmptyNote, Field, FormRow, MicroHeading, Panel, SelectField, StateChip, TextArea, TextInput } from "./ui-bits";
import type { CommerceWorkflow } from "@/lib/commerce/types";

const STEP_TONE: Record<string, "teal" | "amber" | "risk" | "faint"> = {
  done: "teal",
  in_progress: "amber",
  awaiting_approval: "amber",
  failed: "risk",
  pending: "faint",
};

const WF_TONE: Record<string, "teal" | "amber" | "faint" | "risk"> = {
  draft: "faint",
  running: "amber",
  completed: "teal",
  cancelled: "faint",
};

export function WorkflowsSection({ buyerAddress }: { buyerAddress: string | null }) {
  const [workflows, setWorkflows] = useState<CommerceWorkflow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState({ title: "", goal: "", template: "supplier_onboarding", steps: "" });
  const [addFor, setAddFor] = useState<string | null>(null);
  const [addLabel, setAddLabel] = useState("");
  const [addDeskType, setAddDeskType] = useState("");

  const load = useCallback(async () => {
    if (!buyerAddress) return;
    setLoadError(null);
    try {
      const res = await fetch("/api/commerce/workflows", { cache: "no-store" });
      const body = (await res.json()) as { workflows?: CommerceWorkflow[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `your workflows could not be read (${res.status})`);
      setWorkflows(body.workflows ?? []);
    } catch (err) {
      setLoadError(friendlyNetworkError(err));
    }
  }, [buyerAddress]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(payload: Record<string, unknown>, label: string) {
    setBusy(label);
    setActionError(null);
    try {
      const res = await fetch("/api/commerce/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setActionError(body.error ?? `the action failed (${res.status})`);
        return false;
      }
      await load();
      return true;
    } catch (err) {
      setActionError(friendlyNetworkError(err));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function create() {
    const ok = await act({ action: "create", ...form }, "create");
    if (ok) {
      setForm({ title: "", goal: "", template: form.template, steps: "" });
      setFormOpen(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MicroHeading>Your workflows — desk steps ride the Deal Desk engine, free pre-flights included</MicroHeading>
        {buyerAddress && (
          <button type="button" onClick={() => setFormOpen((v) => !v)} className="btn-primary !min-h-9 !text-[12px]">
            {formOpen ? "Close" : "New workflow"}
          </button>
        )}
      </div>
      {!buyerAddress && <EmptyNote>Sign in with your wallet above to set up and run multi-agent workflows.</EmptyNote>}

      {formOpen && buyerAddress && (
        <Panel className="space-y-3">
          <MicroHeading>New commercial job — the plan runs step by step across specialist agents</MicroHeading>
          <Field label="Job title">
            <TextInput value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} maxLength={200} />
          </Field>
          <Field label="What the job must establish">
            <TextArea value={form.goal} onChange={(e) => setForm((p) => ({ ...p, goal: e.target.value }))} />
          </Field>
          <Field label="Plan template" help="Templates pre-fill each desk step with its workflow's worked examples; custom steps are one per line, Label | deskType (omit the desk type for a coordination step).">
            <SelectField value={form.template} onChange={(e) => setForm((p) => ({ ...p, template: e.target.value }))}>
              <option value="supplier_onboarding">Supplier onboarding — counterparty DD, then trade &amp; supplier intelligence</option>
              <option value="asset_listing_review">Asset listing review — asset intelligence, then listing underwriting</option>
              <option value="custom">Custom</option>
            </SelectField>
          </Field>
          {form.template === "custom" && (
            <Field label="Custom steps" help="e.g. “Screen the supplier | counterparty_due_diligence” then “Assign delivery | ” (empty type = coordination).">
              <TextArea value={form.steps} onChange={(e) => setForm((p) => ({ ...p, steps: e.target.value }))} />
            </Field>
          )}
          <FormRow>
            <button type="button" disabled={busy !== null} onClick={() => void create()} className="btn-primary !min-h-9 !text-[12px]">
              {busy === "create" ? "Creating…" : "Create workflow"}
            </button>
          </FormRow>
        </Panel>
      )}

      <ActionError error={actionError} onRetry={() => setActionError(null)} />
      <ActionError error={loadError} onRetry={() => void load()} />

      {workflows === null && buyerAddress && !loadError && <EmptyNote>Loading your workflows…</EmptyNote>}
      {buyerAddress && workflows !== null && workflows.length === 0 && <EmptyNote>No workflows yet — turn a commercial job into a plan.</EmptyNote>}

      {(workflows ?? []).map((wf) => (
        <Panel key={wf.id} className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip tone={WF_TONE[wf.status] ?? "faint"}>{wf.status}</StateChip>
            <span className="tabular text-[11px] text-ink-faint">{wf.reference}</span>
            <span className="tabular ml-auto text-[11px] text-ink-faint">{wf.steps.filter((s) => s.status === "done").length}/{wf.steps.length} done</span>
          </div>
          <h3 className="text-[14px] font-semibold leading-snug text-ink">{wf.title}</h3>
          <p className="text-[12.5px] leading-relaxed text-ink-soft">{wf.goal}</p>

          <ol className="space-y-1.5">
            {wf.steps.map((s, i) => (
              <li key={s.id} className="rounded-lg border border-edge bg-panel-2 px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="tabular text-[11px] font-semibold text-ink-faint">{String(i + 1).padStart(2, "0")}</span>
                  <StateChip tone={STEP_TONE[s.status] ?? "faint"}>{s.status.replace(/_/g, " ")}</StateChip>
                  <span className="text-[12.5px] font-medium text-ink">{s.label}</span>
                  <span className="ml-auto text-[10.5px] text-ink-faint">
                    {s.kind === "desk_investigation" ? "Deal Desk step" : s.serviceId ? "assigned service" : "coordination"}
                  </span>
                </div>
                {s.result && <p className="mt-1 text-[11.5px] leading-relaxed text-ink-soft">{s.result}</p>}
                {s.status === "pending" && (
                  <FormRow>
                    <button type="button" disabled={busy !== null} onClick={() => void act({ action: "runStep", id: wf.id, stepId: s.id }, `run:${s.id}`)} className="btn-signal !min-h-8 !text-[11.5px]">
                      {busy === `run:${s.id}` ? "Running…" : "Run this step"}
                    </button>
                  </FormRow>
                )}
              </li>
            ))}
          </ol>

          {wf.status !== "completed" && wf.status !== "cancelled" && (
            <FormRow>
              {addFor === wf.id ? (
                <span className="w-full space-y-2">
                  <Field label="Add a step" help="A Deal Desk workflow type, or leave it as a coordination step.">
                    <TextInput value={addLabel} onChange={(e) => setAddLabel(e.target.value)} placeholder="Step label" />
                  </Field>
                  <SelectField value={addDeskType} onChange={(e) => setAddDeskType(e.target.value)}>
                    <option value="">Coordination step (no desk run)</option>
                    <option value="counterparty_due_diligence">Counterparty due diligence</option>
                    <option value="asset_intelligence">Asset intelligence</option>
                    <option value="trade_supplier_intelligence">Trade &amp; supplier intelligence</option>
                    <option value="listing_underwriter">Listing underwriter</option>
                  </SelectField>
                  <FormRow>
                    <button
                      type="button"
                      disabled={busy !== null || addLabel.trim() === ""}
                      onClick={() => void act({ action: "addStep", id: wf.id, label: addLabel, ...(addDeskType ? { deskType: addDeskType } : {}) }, `add:${wf.id}`)}
                      className="btn-primary !min-h-8 !text-[11.5px]"
                    >
                      {busy === `add:${wf.id}` ? "Adding…" : "Add step"}
                    </button>
                    <button type="button" onClick={() => setAddFor(null)} className="btn-quiet !min-h-8 !text-[11.5px]">
                      Cancel
                    </button>
                  </FormRow>
                </span>
              ) : (
                <>
                  <button type="button" onClick={() => setAddFor(wf.id)} className="btn-quiet !min-h-8 !text-[11.5px]">
                    Add a step
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void act({ action: "cancel", id: wf.id }, `cancel:${wf.id}`)} className="btn-quiet !min-h-8 !text-[11.5px]">
                    {busy === `cancel:${wf.id}` ? "Cancelling…" : "Cancel workflow"}
                  </button>
                </>
              )}
            </FormRow>
          )}
        </Panel>
      ))}
    </div>
  );
}
