# Hackathon log

- **Project:** StockLens
- **Event:** Cal Hacks 13.0
- **What it does:** StockLens turns existing warehouse CCTV footage into tracked inventory movements with YOLOv8, reconciles them against inventory records in Convex, and lets Claude investigate and explain any mismatch with linked video evidence.
- **Live app:** https://stocklens-hq.vercel.app
- **Repo:** https://github.com/Garimas144/stocklens
- **Frontend:** Vercel
- **Convex deployment:** https://judicious-beagle-180.convex.cloud
- **Components:** none
- **Convex features:** schema (18 tables), indexes (31), queries, mutations, actions (Node runtime), internal queries / mutations / actions, scheduled functions, realtime useQuery
- **Auth:** none
- **AI models:** claude-opus-5-5
- **Started:** 2026-10-25T07:15:22Z
- **Last updated:** 2026-10-25T07:15:22Z

## How we use Convex

- **Live camera wall and dashboard:** the surveillance home, dashboard, inventory and investigations pages subscribe with `useQuery` to read models in `web/convex/ui.ts` (`surveillance`, `overview`, `inventory`, `discrepancy`). New movements, incidents and Claude's investigations appear on these screens without a refresh.
- **Idempotent CV ingestion + reconciliation in one transaction:** the Python YOLOv8 worker publishes movement events through the `publishEvents` mutation in `web/convex/worker.ts`; each event has an idempotency key, and shelf / checkpoint reconciliation runs in the same mutation (`web/convex/lib.ts`), so a physical movement can never be counted twice or half-applied.
- **Discrepancies that investigate themselves:** when reconciliation opens an incident, `lib.ts` schedules `agent.autoInvestigate` with `ctx.scheduler.runAfter`; the Claude agent in `web/convex/agent.ts` (a Node action) reads evidence through internal queries in `web/convex/agentData.ts` and can only *propose* a correction.
- **Human-approved corrections with an audit trail:** `requestCorrection` / `decideCorrection` and incident workflow mutations in `web/convex/ops.ts` validate input, enforce two different approvers and write to the `audit` table defined in `web/convex/schema.ts`.
- **Ask StockLens chat:** `web/convex/assistant.ts` (action) runs Claude with read-only internal-query tools in `web/convex/assistantData.ts`; answers stream progress into the `chatMessages` table, so the chat screen updates live while Claude works.
- **Indexed lookups everywhere:** every hot path (events by session, location and time; incidents by fingerprint; tracks by session) uses indexes declared in `web/convex/schema.ts`.

## Log

The development history was squashed into a single commit before submission (to rename the project from ShelfSight to StockLens), so the git log has one entry.

- **2026-10-25 · 137d57f** · StockLens: full app. `web/convex/*` (schema, ingestion, reconciliation, Claude agent and assistant, UI queries), `web/app/*` (Next.js surveillance wall + workspace), Python CV worker (`process_video.py`, `movement_monitor.py`, `groups.py`, `relevance.py`), tests, README.
