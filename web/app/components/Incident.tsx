"use client";
import Link from "next/link";
import { Doc } from "@/convex/_generated/dataModel";
import { ago, kindLabel } from "@/lib/format";
import { Diff, Status } from "./ui";

type Names = { loc: (id?: string) => string; prod: (sku?: string) => string };

export function headline(d: Doc<"discrepancies">, n: Names) {
  if (d.kind === "misplaced_item") return { title: "Misplaced item", line: `${n.prod(d.sku)} observed on ${n.loc(d.locationId)}.`, sub: `Expected: ${n.loc(d.expectedLocationId)}` };
  if (d.kind === "shelf_quantity") return { title: kindLabel(d.kind), line: `${n.loc(d.locationId)}${d.sku ? ` · ${n.prod(d.sku)}` : ""}`,
    sub: `Records ${d.expectedQty} · cameras ${d.observedQty}${d.unmatchedEventIds.length ? ` · ${d.unmatchedEventIds.length} movement${d.unmatchedEventIds.length > 1 ? "s" : ""} not recorded` : ""}` };
  return { title: d.difference < 0 ? "Recorded but not observed" : kindLabel(d.kind), line: n.loc(d.locationId), sub: `Observed ${d.observedQty} · recorded ${d.expectedQty}${d.unmatchedEventIds.length ? ` · ${d.unmatchedEventIds.length} without a transaction` : ""}` };
}

export default function IncidentRow({ d, names }: { d: Doc<"discrepancies">; names: Names }) {
  const h = headline(d, names);
  return (
    <Link href={`/investigations/${d.code}`} className="item">
      <div style={{ width: 70 }} className="mono faint">{d.code}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="t">{h.title} <span className="muted" style={{ fontWeight: 400 }}>· {h.line}</span></div>
        <div className="s">{h.sub}</div>
      </div>
      <div className="r tnum" style={{ width: 44, textAlign: "right" }}><Diff n={d.difference} /></div>
      <div style={{ width: 110, textAlign: "right" }}><Status s={d.status} /><div className="tiny faint">{ago(d.updatedAt)}</div></div>
    </Link>
  );
}
