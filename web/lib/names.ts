"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";

/** Human names for locations and SKUs, shared by every page. */
export function useNames() {
  const inv = useQuery(api.ui.inventory);
  const locs = new Map([...(inv?.shelves ?? []), ...(inv?.flow ?? [])].map((l) => [l.locationId, l.name]));
  const prods = new Map((inv?.products ?? []).map((p) => [p.sku, p.name]));
  return {
    ready: !!inv,
    loc: (id?: string) => (id ? locs.get(id) ?? id : "unknown location"),
    prod: (sku?: string) => (sku ? prods.get(sku) ?? sku : "Unidentified item"),
  };
}
