"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useOperator } from "../providers";

const I = {
  dash: <svg viewBox="0 0 16 16"><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>,
  inv: <svg viewBox="0 0 16 16"><path d="M2 4.5h12M2 8h12M2 11.5h12" /><path d="M3.5 2v12M12.5 2v12" /></svg>,
  inc: <svg viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5 14 14" /></svg>,
  search: <svg viewBox="0 0 16 16"><path d="M2.5 4h11M2.5 8h7M2.5 12h4" /></svg>,
};

export default function Nav() {
  const path = usePathname();
  const { operator, setOperator } = useOperator();
  const active = useQuery(api.ui.discrepancies, { status: "active" });
  const on = (h: string) => (path.startsWith(h) ? "on" : "");
  return (
    <aside className="side">
      <div className="logo"><i />StockLens</div>
      <Link href="/" className="backsurv"><span>←</span> Back to Surveillance</Link>
      <nav>
        <Link href="/dashboard" className={on("/dashboard")}>{I.dash}Dashboard</Link>
        <Link href="/inventory" className={on("/inventory")}>{I.inv}Inventory</Link>
        <Link href="/investigations" className={on("/investigations")}>{I.inc}Investigations{active?.length ? <span className="count">{active.length}</span> : null}</Link>
      </nav>
      <div className="sub">Records</div>
      <nav><Link href="/search" className={on("/search")}>{I.search}Movement log</Link></nav>
      <div className="grow" />
      <div className="who">
        <span className="livedot">Synced with Convex</span>
        <div style={{ marginTop: 12 }}>Operator</div>
        <input value={operator} onChange={(e) => setOperator(e.target.value)} placeholder="Your name (audit trail)" />
      </div>
    </aside>
  );
}
