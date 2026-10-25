"use node";
/**
 * Claude inventory investigation agent (Anthropic API, manual tool-use loop inside a Convex action).
 *
 * Division of labour: reconciliation numbers come from deterministic Convex code. Claude only reads records through the
 * read-only tools below, explains what they show, separates facts from hypotheses, and may (a) save findings, (b) request a
 * human review, or (c) propose a record correction that stays pending until an operator approves it. It cannot change
 * inventory, events or discrepancy numbers.
 */
import Anthropic from "@anthropic-ai/sdk";
import { action, internalAction, ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_TURNS = 10;

const SYSTEM = `You are the inventory investigation agent for a warehouse visual-intelligence platform. CCTV footage is processed by
YOLOv8 + ByteTrack into movement events (shelf additions/removals, checkpoint crossings). Deterministic code compares them with
warehouse management records and opens discrepancies. Your job is to explain a discrepancy to a warehouse supervisor.

Rules:
- Use the tools to retrieve records. Never state a quantity, time, identity, event or piece of evidence you did not retrieve.
- The reconciliation numbers are computed by the system; do not recompute or alter them, only explain them.
- Tracking ids such as "Package 3" are scoped to one video session; they are not product identities. Do not invent SKUs or package ids.
- For misplaced-item incidents, say how the product identity was established (event identitySource) and where the product belongs.
- Uncertain or unverified observations are not proof. Never conclude theft, loss or fault from tracking alone.
- Inventory records are only changed by humans. You may propose a correction, which stays pending until an operator approves it,
  and only when the evidence is confirmed (verification "confirmed", counted toward reconciliation).
- Finish by calling save_findings exactly once. facts = statements directly supported by retrieved records (cite their ids);
  hypotheses = plausible explanations that the records do not prove; missing_evidence = what is absent or uncertain;
  recommendation = one concrete next operational step. citations = the eventId / txnId / discrepancy code values you relied on.
- Write plainly for a warehouse supervisor. Do not use em dashes.`;

const tools: Anthropic.Tool[] = [
  { name: "get_discrepancy", description: "Get a discrepancy by code (e.g. INC-101): recorded vs observed quantities, the supporting, unmatched and uncertain event ids, unmatched transaction ids, status and recent notes.",
    input_schema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false } },
  { name: "get_location", description: "Get a shelf or checkpoint: verified starting quantity and when/by whom, whether the camera sees it fully, recorded inventory per SKU, and the current reconciliation state.",
    input_schema: { type: "object", properties: { location_id: { type: "string" } }, required: ["location_id"], additionalProperties: false } },
  { name: "list_movement_events", description: "List physical movement events (camera-inferred). Filter by event_ids, or by location_id / session_id / camera_id with optional ISO time range and type (shelf_addition, shelf_removal, checkpoint_crossing). Each event includes its verification state, reasons and video evidence reference.",
    input_schema: { type: "object", properties: { event_ids: { type: "array", items: { type: "string" } }, location_id: { type: "string" }, session_id: { type: "string" }, camera_id: { type: "string" }, from: { type: "string" }, to: { type: "string" }, type: { type: "string" } }, additionalProperties: false } },
  { name: "list_transactions", description: "List recorded inventory transactions (warehouse management records) at a location, optionally in an ISO time range.",
    input_schema: { type: "object", properties: { location_id: { type: "string" }, from: { type: "string" }, to: { type: "string" } }, required: ["location_id"], additionalProperties: false } },
  { name: "get_track", description: "Get the tracking history of one tracked object in one video session: first/last seen, route, uncertainty notes, sampled trajectory.",
    input_schema: { type: "object", properties: { session_id: { type: "string" }, track_ref: { type: "string" } }, required: ["session_id", "track_ref"], additionalProperties: false } },
  { name: "request_review", description: "Ask a human to review this discrepancy (moves it to 'investigating' and adds a note). Use when evidence is uncertain or footage should be checked.",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"], additionalProperties: false } },
  { name: "propose_correction", description: "Propose changing the recorded quantity of the discrepancy's SKU at its shelf. Creates a PENDING correction that an operator must approve; it changes nothing by itself. Only for confirmed evidence.",
    input_schema: { type: "object", properties: { to_quantity: { type: "number" }, reason: { type: "string" } }, required: ["to_quantity", "reason"], additionalProperties: false } },
  { name: "save_findings", description: "Save the investigation result for operator review. Call exactly once, at the end.",
    input_schema: { type: "object", properties: {
      summary: { type: "string", description: "3-6 sentence explanation of what appears to have happened" },
      facts: { type: "array", items: { type: "string" } }, hypotheses: { type: "array", items: { type: "string" } },
      missing_evidence: { type: "array", items: { type: "string" } }, recommendation: { type: "string" }, citations: { type: "array", items: { type: "string" } },
    }, required: ["summary", "facts", "hypotheses", "missing_evidence", "recommendation", "citations"], additionalProperties: false } },
];

function collectIds(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) value.forEach((x) => collectIds(x, out));
  else if (value && typeof value === "object") {
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      if ((k === "eventId" || k === "txnId" || k === "code" || k === "reference") && typeof x === "string") out.add(x);
      else if (/(EventIds|TransactionIds)$/.test(k) && Array.isArray(x)) x.forEach((i) => typeof i === "string" && out.add(i));
      else collectIds(x, out);
    }
  }
}

async function runAgent(ctx: ActionCtx, discrepancyId: Id<"discrepancies"> | undefined, question: string, requestedBy: string): Promise<Id<"agentRuns">> {
  const runId: Id<"agentRuns"> = await ctx.runMutation(internal.agentData.startRun, { discrepancyId, question, requestedBy, model: MODEL });
  if (!process.env.ANTHROPIC_API_KEY) {
    await ctx.runMutation(internal.agentData.finishRun, { runId, status: "not_configured", error: "ANTHROPIC_API_KEY is not set on this Convex deployment (npx convex env set ANTHROPIC_API_KEY ...)." });
    return runId;
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, ...(process.env.ANTHROPIC_API_URL ? { baseURL: process.env.ANTHROPIC_API_URL } : {}) });
  const code = discrepancyId ? await ctx.runQuery(internal.agentData.discrepancyCode, { id: discrepancyId }) : null;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: (code ? `Discrepancy: ${code}\n` : "") + `Question from ${requestedBy}: ${question}` }];
  const retrieved = new Set<string>(code ? [code] : []);
  let saved = false;
  try {
    for (let turn = 0; turn < MAX_TURNS && !saved; turn++) {
      // server-side refusal fallback: if the model declines on a safety classifier, the API reroutes to a fallback model
      const response = (await client.beta.messages.create({
        model: MODEL, max_tokens: 16000, system: SYSTEM, tools, messages,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
      } as any)) as unknown as Anthropic.Message;
      if (response.stop_reason === "refusal") throw new Error("the model declined this request");
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        // answered in text without saving: keep the text, but mark that nothing structured was saved
        const text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
        await ctx.runMutation(internal.agentData.finishRun, { runId, status: "done", answer: text, facts: [], hypotheses: [], missingEvidence: ["agent ended without structured findings"], citations: [], retrievedIds: [...retrieved] });
        return runId;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        const input = u.input as Record<string, any>;
        let output: unknown;
        try {
          switch (u.name) {
            case "get_discrepancy": output = await ctx.runQuery(internal.agentData.toolGetDiscrepancy, { code: String(input.code) }); break;
            case "get_location": output = await ctx.runQuery(internal.agentData.toolGetLocation, { locationId: String(input.location_id) }); break;
            case "list_movement_events": output = await ctx.runQuery(internal.agentData.toolListEvents, {
              eventIds: input.event_ids, locationId: input.location_id, sessionId: input.session_id, cameraId: input.camera_id, from: input.from, to: input.to, type: input.type }); break;
            case "list_transactions": output = await ctx.runQuery(internal.agentData.toolListTransactions, { locationId: String(input.location_id), from: input.from, to: input.to }); break;
            case "get_track": output = await ctx.runQuery(internal.agentData.toolGetTrack, { sessionId: String(input.session_id), trackRef: String(input.track_ref) }); break;
            case "request_review":
              output = discrepancyId ? await ctx.runMutation(internal.agentData.agentRequestReview, { runId, discrepancyId, reason: String(input.reason) }) : "no discrepancy in scope"; break;
            case "propose_correction":
              output = discrepancyId ? await ctx.runMutation(internal.agentData.agentProposeCorrection, { runId, discrepancyId, toQty: Number(input.to_quantity), reason: String(input.reason) }) : "no discrepancy in scope"; break;
            case "save_findings":
              await ctx.runMutation(internal.agentData.finishRun, {
                runId, status: "done", answer: String(input.summary), facts: input.facts ?? [], hypotheses: input.hypotheses ?? [],
                missingEvidence: input.missing_evidence ?? [], recommendation: input.recommendation, citations: input.citations ?? [], retrievedIds: [...retrieved],
              });
              saved = true;
              output = "saved";
              break;
            default: output = { error: `unknown tool ${u.name}` };
          }
        } catch (err) {
          output = { error: String(err) };
        }
        collectIds(output, retrieved);
        const text = typeof output === "string" ? output : JSON.stringify(output);
        await ctx.runMutation(internal.agentData.addStep, { runId, tool: u.name, input, output: text });
        results.push({ type: "tool_result", tool_use_id: u.id, content: text });
      }
      messages.push({ role: "user", content: results });
    }
    if (!saved) await ctx.runMutation(internal.agentData.finishRun, { runId, status: "error", error: `stopped after ${MAX_TURNS} turns without saving findings`, retrievedIds: [...retrieved] });
  } catch (err) {
    await ctx.runMutation(internal.agentData.finishRun, { runId, status: "error", error: err instanceof Error ? err.message : String(err), retrievedIds: [...retrieved] });
  }
  return runId;
}

export const investigate = action({
  args: { discrepancyId: v.optional(v.id("discrepancies")), question: v.string(), operator: v.string() },
  handler: async (ctx, { discrepancyId, question, operator }): Promise<Id<"agentRuns">> => {
    const op = operator.trim();
    if (op.length < 2) throw new Error("operator name required");
    if (!question.trim()) throw new Error("question required");
    return await runAgent(ctx, discrepancyId, question.trim().slice(0, 2000), op);
  },
});

export const autoInvestigate = internalAction({
  args: { discrepancyId: v.id("discrepancies") },
  handler: async (ctx, { discrepancyId }) => {
    await runAgent(ctx, discrepancyId, "A new discrepancy was opened. Investigate what happened, cite the evidence, and recommend the next step.", "system (auto)");
  },
});
