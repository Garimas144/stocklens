"use client";

/** Opens the Ask StockLens chat (bottom-right launcher) with the current page's context (incident, shelf, camera or movement). */
export default function AskButton({ kind, id, label, text = "Ask StockLens" }: { kind: string; id: string; label: string; text?: string }) {
  return (
    <button type="button" className="askbtn" onClick={() => window.dispatchEvent(new CustomEvent("stocklens:ask", { detail: { kind, ref: id, label } }))}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M8 1.8 9.3 6.7 14.2 8 9.3 9.3 8 14.2 6.7 9.3 1.8 8 6.7 6.7Z" /></svg>{text}
    </button>
  );
}
