export const fmtTime = (ms?: number | null) =>
  ms == null ? "—" : new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const fmtClock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(0).padStart(2, "0")}`;
export const ago = (ms: number) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now"; if (s < 3600) return `${Math.round(s / 60)}m ago`; if (s < 86400) return `${Math.round(s / 3600)}h ago`; return `${Math.round(s / 86400)}d ago`;
};
export const eventLabel = (e: { type: string; direction?: string; againstFlow?: boolean }) =>
  e.type === "shelf_addition" ? "Added to shelf" : e.type === "shelf_removal" ? "Removed from shelf" : `${e.direction === "inbound" ? "Inbound" : "Outbound"} movement${e.againstFlow ? " (reverse)" : ""}`;
export const kindLabel = (k: string) => ({ shelf_quantity: "Inventory mismatch", checkpoint_count: "Unrecorded movement", misplaced_item: "Misplaced item" } as Record<string, string>)[k] ?? k;
export const AREA: Record<string, string> = { receiving: "Receiving", storage: "Storage", aisle: "Warehouse aisle", dispatch: "Dispatch", other: "Other" };
