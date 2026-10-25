import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex is the system of record for operations. The Python YOLOv8 worker only publishes structured, confirmed business
 * events (plus per-track summaries for evidence); it never writes inventory quantities directly.
 *
 * Layers kept separate on purpose:
 *   tracks            low-level visual observations (scoped to one camera session; tracker ids are NOT identities)
 *   movementEvents    inferred physical movements (shelf additions/removals, checkpoint crossings) with verification state
 *   inventoryRecords  what the warehouse management system says (authoritative records; only changed via approved corrections)
 *   discrepancies     deterministic comparison of the two, with an investigation workflow
 */
export default defineSchema({
  cameras: defineTable({
    cameraId: v.string(),
    name: v.string(),
    profile: v.union(v.literal("shelf"), v.literal("movement")),
    context: v.string(), // e.g. "storage shelf", "conveyor", "receiving dock", "dispatch"
    warehouseLocation: v.string(),
    source: v.object({ kind: v.union(v.literal("file"), v.literal("rtsp")), uri: v.string(), recordedAt: v.optional(v.number()) }),
    config: v.any(), // zones (with shelf location ids), count lines (with checkpoint location ids), thresholds; validated on write
    status: v.string(), // "idle" | "processing" | "error"
    slot: v.optional(v.number()), // position in the camera network (1-4 = main grid)
    area: v.optional(v.string()), // receiving | storage | aisle | dispatch | other
    updatedAt: v.number(),
    updatedBy: v.string(),
  }).index("by_cameraId", ["cameraId"]),

  products: defineTable({
    sku: v.string(),
    name: v.string(),
    category: v.string(),
    expectedLocationId: v.optional(v.string()), // where this product belongs
    unit: v.optional(v.string()),
    isSample: v.boolean(),
  }).index("by_sku", ["sku"]),

  locations: defineTable({
    locationId: v.string(),
    name: v.string(),
    type: v.union(v.literal("shelf"), v.literal("checkpoint"), v.literal("zone")), // zone = observation only (aisles)
    cameraId: v.string(), // camera that observes it (for checkpoints: the counting camera)
    sku: v.optional(v.string()),
    // shelf
    verifiedQty: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    verifiedBy: v.optional(v.string()),
    fullyVisible: v.optional(v.boolean()),
    // checkpoint
    direction: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))),
    matchToleranceS: v.optional(v.number()),
    // derived by reconciliation (never written by clients)
    state: v.optional(v.any()),
    updatedAt: v.number(),
  })
    .index("by_locationId", ["locationId"])
    .index("by_camera", ["cameraId"]),

  inventoryRecords: defineTable({
    sku: v.string(),
    description: v.optional(v.string()),
    locationId: v.string(),
    recordedQty: v.number(),
    isSample: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_location", ["locationId"])
    .index("by_sku", ["sku"]),

  transactions: defineTable({
    txnId: v.string(),
    type: v.union(v.literal("receipt"), v.literal("putaway"), v.literal("pick"), v.literal("outbound"), v.literal("inbound"), v.literal("adjustment")),
    locationId: v.string(),
    sku: v.optional(v.string()),
    packageId: v.optional(v.string()),
    quantity: v.number(),
    at: v.number(),
    reference: v.optional(v.string()),
    source: v.string(), // "wms_sample" | "operator_correction" | "wms_import"
    isSample: v.boolean(),
  })
    .index("by_txnId", ["txnId"])
    .index("by_location_at", ["locationId", "at"]),

  sessions: defineTable({
    sessionId: v.string(),
    cameraId: v.string(),
    status: v.string(), // queued | processing | done | error
    progress: v.number(),
    startedAt: v.number(), // wall-clock time of the first frame (operator supplied for recorded footage)
    durationS: v.optional(v.number()),
    fps: v.optional(v.number()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    originalUrl: v.optional(v.string()),
    processedUrl: v.optional(v.string()),
    models: v.optional(v.any()),
    stats: v.optional(v.any()),
    error: v.optional(v.string()),
    // reference-frame -> image affine [a, b, c, d, e, f] sampled over time, so overlays drawn in reference coordinates (ROI, lines,
    // shelves) follow a moving camera
    cameraPath: v.optional(v.array(v.object({ t: v.number(), m: v.array(v.number()) }))),
    updatedAt: v.number(),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_camera", ["cameraId", "startedAt"]),

  tracks: defineTable({
    sessionId: v.string(),
    cameraId: v.string(),
    trackRef: v.string(), // "Package 3" - only meaningful inside this session
    kind: v.string(), // package | person
    trackerIds: v.string(), // raw ByteTrack ids, audit only
    packageId: v.optional(v.string()), // confirmed real identity, set by an operator or barcode association
    sku: v.optional(v.string()),
    firstSeenS: v.number(),
    lastSeenS: v.number(),
    meanConf: v.number(),
    status: v.string(),
    lossClass: v.optional(v.string()),
    route: v.array(v.string()),
    uncertainty: v.array(v.string()),
    samples: v.array(v.object({ t: v.number(), x: v.number(), y: v.number(), bbox: v.array(v.number()), conf: v.number(), zone: v.string() })),
    evidence: v.optional(v.object({ firstUrl: v.optional(v.string()), lastUrl: v.optional(v.string()) })),
    relevance: v.optional(v.string()), // monitored | background_static | outside_roi (movement cameras); background never counts
    trackingQuality: v.optional(v.number()), // 0-1, separate from detector confidence
    category: v.optional(v.string()), // generic "package", or a reliable COCO class such as "bottle"; never a SKU
  })
    .index("by_session", ["sessionId", "trackRef"])
    .index("by_package", ["packageId"]),

  movementEvents: defineTable({
    eventKey: v.string(), // idempotency key computed by the worker from (camera, session, type, location, slot/line, track, frame)
    sessionId: v.string(),
    cameraId: v.string(),
    locationId: v.string(),
    type: v.union(v.literal("shelf_addition"), v.literal("shelf_removal"), v.literal("checkpoint_crossing")),
    direction: v.optional(v.union(v.literal("inbound"), v.literal("outbound"))),
    againstFlow: v.optional(v.boolean()),
    fromZone: v.optional(v.string()),
    toZone: v.optional(v.string()),
    trackRef: v.string(),
    packageId: v.optional(v.string()),
    sku: v.optional(v.string()),
    identitySource: v.optional(v.string()), // operator | barcode | cv_category ; absent = anonymous object
    t: v.number(), // seconds into the session video
    at: v.number(), // wall clock
    quantity: v.number(),
    confidence: v.optional(v.number()),
    detectionConf: v.optional(v.number()), // YOLO confidence around the event
    trackingQuality: v.optional(v.number()), // did the observations consistently belong to one object
    eventConf: v.optional(v.number()), // how clearly the trajectory satisfied the movement rule
    verification: v.union(v.literal("confirmed"), v.literal("uncertain"), v.literal("rejected"), v.literal("superseded")),
    verifiedBy: v.optional(v.string()), // "cv" or the operator who reviewed it
    countsTowardReconciliation: v.boolean(),
    countingNote: v.optional(v.string()),
    reasons: v.array(v.string()),
    actor: v.optional(v.string()),
    evidence: v.object({ imageUrl: v.optional(v.string()), videoUrl: v.optional(v.string()), t: v.number() }),
    ingestedAt: v.number(),
  })
    .index("by_key", ["eventKey"])
    .index("by_location_at", ["locationId", "at"])
    .index("by_session", ["sessionId", "t"])
    .index("by_camera_at", ["cameraId", "at"])
    .index("by_package", ["packageId"])
    .index("by_at", ["at"]),

  discrepancies: defineTable({
    code: v.string(), // INC-101
    fingerprint: v.string(), // one active discrepancy per location (+ session window for checkpoints)
    kind: v.union(v.literal("shelf_quantity"), v.literal("checkpoint_count"), v.literal("misplaced_item")),
    expectedLocationId: v.optional(v.string()),
    locationId: v.string(),
    cameraId: v.string(),
    sessionId: v.optional(v.string()),
    sku: v.optional(v.string()),
    expectedQty: v.number(), // what the records say
    observedQty: v.number(), // what the cameras support
    difference: v.number(), // observed - expected
    window: v.object({ from: v.number(), to: v.number() }),
    supportingEventIds: v.array(v.id("movementEvents")),
    unmatchedEventIds: v.array(v.id("movementEvents")),
    unmatchedTxnIds: v.array(v.id("transactions")),
    uncertainEventIds: v.array(v.id("movementEvents")),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    summary: v.string(),
    active: v.boolean(),
    status: v.union(v.literal("open"), v.literal("investigating"), v.literal("escalated"), v.literal("resolved"), v.literal("dismissed")),
    assignee: v.optional(v.string()),
    resolution: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_code", ["code"])
    .index("by_fingerprint", ["fingerprint", "active"])
    .index("by_status", ["status", "updatedAt"])
    .index("by_location", ["locationId", "createdAt"]),

  investigationNotes: defineTable({
    discrepancyId: v.id("discrepancies"),
    author: v.string(),
    kind: v.string(), // note | status | assignment | system | agent | correction | evidence_review
    body: v.string(),
    at: v.number(),
  }).index("by_discrepancy", ["discrepancyId", "at"]),

  corrections: defineTable({
    discrepancyId: v.id("discrepancies"),
    locationId: v.string(),
    sku: v.string(),
    fromQty: v.number(),
    toQty: v.number(),
    reason: v.string(),
    status: v.union(v.literal("pending"), v.literal("approved"), v.literal("rejected")),
    requestedBy: v.string(),
    decidedBy: v.optional(v.string()),
    decisionNote: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  })
    .index("by_discrepancy", ["discrepancyId"])
    .index("by_status", ["status"]),

  agentRuns: defineTable({
    discrepancyId: v.optional(v.id("discrepancies")),
    question: v.string(),
    requestedBy: v.string(),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("not_configured")),
    model: v.string(),
    steps: v.array(v.object({ tool: v.string(), input: v.any(), output: v.string(), at: v.number() })),
    answer: v.optional(v.string()),
    facts: v.optional(v.array(v.string())),
    hypotheses: v.optional(v.array(v.string())),
    missingEvidence: v.optional(v.array(v.string())),
    recommendation: v.optional(v.string()),
    citations: v.optional(v.array(v.string())),
    invalidCitations: v.optional(v.array(v.string())),
    error: v.optional(v.string()),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  }).index("by_discrepancy", ["discrepancyId", "startedAt"]),

  jobs: defineTable({
    cameraId: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("error")),
    sessionId: v.optional(v.string()),
    progress: v.number(),
    requestedBy: v.string(),
    reuseCache: v.boolean(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_status", ["status", "createdAt"]),

  audit: defineTable({
    at: v.number(),
    actor: v.string(),
    action: v.string(),
    entity: v.string(),
    entityId: v.string(),
    details: v.optional(v.any()),
  }).index("by_at", ["at"]),

  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),

  // Ask StockLens: conversations with the visual memory (read-only assistant)
  conversations: defineTable({
    title: v.string(),
    createdBy: v.string(),
    context: v.optional(v.object({ kind: v.string(), ref: v.string(), label: v.string() })), // incident | shelf | camera | event | sku
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_updated", ["updatedAt"]),

  chatMessages: defineTable({
    conversationId: v.id("conversations"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    author: v.string(),
    text: v.string(),
    status: v.union(v.literal("thinking"), v.literal("done"), v.literal("error")),
    progress: v.optional(v.string()),
    steps: v.array(v.object({ tool: v.string(), input: v.any(), summary: v.string() })),
    refs: v.array(v.object({ key: v.string(), kind: v.string(), label: v.string(), href: v.optional(v.string()), videoUrl: v.optional(v.string()), t: v.optional(v.number()), imageUrl: v.optional(v.string()), cameraId: v.optional(v.string()) })),
    invalidRefs: v.optional(v.array(v.string())),
    model: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_conversation", ["conversationId", "createdAt"]),
});
