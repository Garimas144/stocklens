"use node";
/**
 * Ask StockLens: a conversational, read-only assistant over the warehouse's visual memory.
 * Claude (Anthropic API, server-side only) answers with narrow tool calls into Convex and cites the records it used.
 * Citations are checked against what the tools actually returned; anything else is removed and flagged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_TURNS = 8;

const SYSTEM = `You are StockLens, the assistant inside a warehouse inventory product. Existing CCTV cameras are processed with
YOLOv8 + ByteTrack into movement events (boxes added to or removed from shelves, packages crossing receiving, aisle and dispatch
lines). Deterministic code compares those with the warehouse's inventory records and opens incidents. You help warehouse operators
understand what is on their shelves, what is missing or misplaced, what the cameras saw, and what to do next.

How to work
- Use the tools to look things up. Ask only for what you need; do not try to load everything.
- Every factual statement must come from tool results in this conversation. Never invent quantities, times, product identities,
  package ids, movements, footage or cross-camera matches. If the records cannot answer, say exactly what is missing.
- Tracking ids such as "Package 14" belong to one recording of one camera. The same label in another camera is a different object.
  Only treat observations from different cameras as the same item when they share a verified package id or SKU link.
- Cameras confirm that a box was added or removed; they do not read what is inside a box. Products are known only from shelf
  assignments or a verified identity (operator link, barcode, visual classification). Say which.
- Separate what is confirmed (verification "confirmed") from what is uncertain (needs review, low confidence, partly visible shelf).
- Inventory records, products and starting counts in this demo may be sample data (isSample); mention it when it matters.
- Never claim theft. You are read-only: you cannot change inventory, incidents or records. Point the operator to the action instead.

How to answer
- Lead with the direct answer in one or two sentences, then the supporting detail. Keep it short and plain; use "- " bullets for lists.
- Cite records inline with these markers, using ids exactly as the tools returned them:
  [[ev:<eventId>]] for a camera movement (it becomes a clickable clip at the right timestamp),
  [[inc:<code>]] for an incident, [[loc:<locationId>]] for a shelf or flow point, [[cam:<cameraId>]] for a camera, [[sku:<sku>]] for a product.
  Put each marker right after the sentence it supports. When the operator asks to see footage, cite the relevant [[ev:...]] markers.
- Use local wording ("Shelf 2", "Camera 2 · Storage shelving") rather than raw ids in prose. Do not use em dashes.`;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object" as const, properties, required, additionalProperties: false });
const tools: Anthropic.Tool[] = [
  { name: "list_shelves", description: "All shelves with assigned product, recorded quantity, camera-supported physical estimate, difference, status and open incident codes.", input_schema: obj({}) },
  { name: "get_location", description: "One shelf or flow point (receiving, aisle, dispatch) by id or name, e.g. 'Shelf 2' or 'DOCK-OUT-1': quantities, recent camera movements with evidence, recorded transactions, open incidents.", input_schema: obj({ location: { type: "string" } }, ["location"]) },
  { name: "list_products", description: "Product catalogue: SKU, name, category and the shelf each product belongs on.", input_schema: obj({}) },
  { name: "search_movements", description: "Camera-observed movements, newest first. Filter by location (id or name), cameraId, type (shelf_addition, shelf_removal, checkpoint_crossing), trackRef, sku, packageId, verification (confirmed, uncertain), or unmatchedOnly=true for movements with no matching inventory transaction.",
    input_schema: obj({ locationId: { type: "string" }, cameraId: { type: "string" }, type: { type: "string" }, trackRef: { type: "string" }, sku: { type: "string" }, packageId: { type: "string" }, verification: { type: "string" }, unmatchedOnly: { type: "boolean" }, limit: { type: "number" } }) },
  { name: "get_movements_by_id", description: "Specific camera movements by eventId (for example the movement the operator opened this conversation from).", input_schema: obj({ eventIds: { type: "array", items: { type: "string" } } }, ["eventIds"]) },
  { name: "list_incidents", description: "Incidents (inventory mismatches, unrecorded movements, misplaced items). Default: unresolved ones. status: 'all', 'resolved', 'open'...; kind: shelf_quantity, checkpoint_count, misplaced_item.", input_schema: obj({ status: { type: "string" }, kind: { type: "string" } }) },
  { name: "get_incident", description: "Full detail of one incident by code (e.g. INC-102): numbers, supporting/unmatched/uncertain event ids, notes.", input_schema: obj({ code: { type: "string" } }, ["code"]) },
  { name: "get_camera", description: "What one camera observed in its latest recording. Accepts a camera id, a slot like 'CAM 02' or '2', or an area like 'dispatch'.", input_schema: obj({ camera: { type: "string" } }, ["camera"]) },
  { name: "get_track", description: "History of a tracked object such as 'Package 14': route through zones, caveats, and its movements. Returns every recording that has that label.", input_schema: obj({ trackRef: { type: "string" }, cameraId: { type: "string" } }, ["trackRef"]) },
  { name: "get_item_history", description: "Cross-camera history of an item with a verified identity, by sku or packageId. Anonymous tracks never appear here.", input_schema: obj({ sku: { type: "string" }, packageId: { type: "string" } }) },
];
const PROGRESS: Record<string, string> = {
  list_shelves: "Checking shelf inventory", get_location: "Looking up the location", list_products: "Checking product assignments",
  search_movements: "Searching camera movements", get_movements_by_id: "Opening the movement", list_incidents: "Reviewing open incidents", get_incident: "Opening the incident",
  get_camera: "Reviewing camera observations", get_track: "Following the tracked object", get_item_history: "Tracing the item across cameras",
};

function collect(value: unknown, out: Set<string>) {
  if (Array.isArray(value)) value.forEach((x) => collect(x, out));
  else if (value && typeof value === "object") {
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      if (typeof x === "string") {
        if (k === "eventId") out.add(`ev:${x}`);
        else if (k === "code") out.add(`inc:${x}`);
        else if (k === "locationId" || k === "location" || k === "belongsOn" || k === "expectedLocation") out.add(`loc:${x}`);
        else if (k === "cameraId" || k === "camera") out.add(`cam:${x}`);
        else if (k === "sku") out.add(`sku:${x}`);
      } else if (Array.isArray(x) && /EventIds$/.test(k)) x.forEach((i) => typeof i === "string" && out.add(`ev:${i}`));
      else collect(x, out);
    }
  }
}

export const send = action({
  args: { conversationId: v.id("conversations"), text: v.string(), operator: v.string() },
  handler: async (ctx, { conversationId, text, operator }): Promise<{ ok: boolean }> => {
    const op = operator.trim();
    if (op.length < 2) throw new Error("Enter your name in the sidebar first (it is recorded with every question).");
    const question = text.trim().slice(0, 4000);
    if (!question) throw new Error("empty question");
    const { assistantId, history, context, knownRefs } = await ctx.runMutation(internal.assistantData.addUserAndPlaceholder, { conversationId, author: op, text: question });
    const fail = (error: string) => ctx.runMutation(internal.assistantData.finish, { id: assistantId, status: "error", text: "", error, refs: [] });
    if (!process.env.ANTHROPIC_API_KEY) {
      await fail("Claude is not configured. Set ANTHROPIC_API_KEY on the Convex deployment (npx convex env set ANTHROPIC_API_KEY ...). No answer was generated.");
      return { ok: false };
    }
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, ...(process.env.ANTHROPIC_API_URL ? { baseURL: process.env.ANTHROPIC_API_URL } : {}) });
    const ctxLine = !context ? "" : context.kind === "track"
      ? `\n\nThe operator selected the tracked object "${context.ref.split("|")[1]}" in the recording of camera ${context.ref.split("|")[0]} (${context.label}). Use get_track with that cameraId. "This", "it" or "the item" mean that object.`
      : `\n\nThe operator opened this conversation from ${context.kind} ${context.ref} (${context.label}). Questions like "this", "it" or "the item" refer to it unless they say otherwise.`;
    const system = SYSTEM + ctxLine
      + `\nCurrent time: ${new Date().toISOString()}.`;
    const messages: Anthropic.MessageParam[] = [...history.map((m: { role: "user" | "assistant"; text: string }) => ({ role: m.role, content: m.text })), { role: "user", content: question }];
    const retrieved = new Set<string>(knownRefs);
    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = (await client.beta.messages.create({
          model: MODEL, max_tokens: 16000, system, tools, messages, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        } as any)) as unknown as Anthropic.Message;
        if (response.stop_reason === "refusal") { await fail("The model declined to answer this request."); return { ok: false }; }
        messages.push({ role: "assistant", content: response.content });
        if (response.stop_reason === "pause_turn") continue;
        const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (!uses.length) {
          const raw = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
          const keys = [...new Set([...raw.matchAll(/\[\[(ev|inc|loc|cam|sku):([^\]]+)\]\]/g)].map((m) => `${m[1]}:${m[2].trim()}`))];
          const allowed = keys.filter((k) => retrieved.has(k));
          const refs = await ctx.runQuery(internal.assistantData.resolveRefs, { keys: allowed });
          const ok = new Set(refs.map((r: { key: string }) => r.key));
          const invalid = keys.filter((k) => !ok.has(k));
          const cleaned = raw.replace(/\[\[(ev|inc|loc|cam|sku):([^\]]+)\]\]/g, (m, a, b) => (ok.has(`${a}:${b.trim()}`) ? `[[${a}:${b.trim()}]]` : ""));
          await ctx.runMutation(internal.assistantData.finish, { id: assistantId, status: "done", text: cleaned, model: response.model ?? MODEL, refs, invalidRefs: invalid });
          return { ok: true };
        }
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const u of uses) {
          const a = u.input as Record<string, any>;
          await ctx.runMutation(internal.assistantData.progress, { id: assistantId, progress: PROGRESS[u.name] ?? "Looking things up" });
          let out: unknown;
          try {
            switch (u.name) {
              case "list_shelves": out = await ctx.runQuery(internal.assistantData.tShelves, {}); break;
              case "get_location": out = await ctx.runQuery(internal.assistantData.tLocation, { location: String(a.location) }); break;
              case "list_products": out = await ctx.runQuery(internal.assistantData.tProducts, {}); break;
              case "search_movements": out = await ctx.runQuery(internal.assistantData.tMovements, Object.fromEntries(Object.entries(a).filter(([, x]) => x !== null && x !== ""))); break;
              case "get_movements_by_id": out = await ctx.runQuery(internal.agentData.toolListEvents, { eventIds: (a.eventIds ?? []).map(String) }); break;
              case "list_incidents": out = await ctx.runQuery(internal.assistantData.tIncidents, { status: a.status, kind: a.kind }); break;
              case "get_incident": out = await ctx.runQuery(internal.agentData.toolGetDiscrepancy, { code: String(a.code).toUpperCase() }); break;
              case "get_camera": out = await ctx.runQuery(internal.assistantData.tCamera, { camera: String(a.camera) }); break;
              case "get_track": out = await ctx.runQuery(internal.assistantData.tTrack, { trackRef: String(a.trackRef), cameraId: a.cameraId }); break;
              case "get_item_history": out = await ctx.runQuery(internal.assistantData.tItemHistory, { sku: a.sku, packageId: a.packageId }); break;
              default: out = { error: `unknown tool ${u.name}` };
            }
          } catch (err) { out = { error: String(err) }; }
          collect(out, retrieved);
          const s = JSON.stringify(out);
          await ctx.runMutation(internal.assistantData.progress, { id: assistantId, progress: PROGRESS[u.name] ?? "Looking things up",
            step: { tool: u.name, input: a, summary: s.length > 600 ? s.slice(0, 600) + "…" : s } });
          results.push({ type: "tool_result", tool_use_id: u.id, content: s });
        }
        messages.push({ role: "user", content: results });
      }
      await fail(`Stopped after ${MAX_TURNS} lookups without a final answer. Try a narrower question.`);
      return { ok: false };
    } catch (err) {
      const msg = err instanceof Anthropic.AuthenticationError ? "Claude rejected the API key (ANTHROPIC_API_KEY on the Convex deployment)."
        : err instanceof Anthropic.RateLimitError ? "Claude rate limit reached; try again in a minute."
        : err instanceof Anthropic.APIConnectionError ? "Could not reach the Claude API from the Convex deployment."
        : err instanceof Error ? err.message : String(err);
      await fail(msg);
      return { ok: false };
    }
  },
});

export type _Id = Id<"conversations">;
