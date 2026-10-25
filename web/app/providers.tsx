"use client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";

const convex = new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL as string);

type Op = { operator: string; setOperator: (s: string) => void };
const OperatorCtx = createContext<Op>({ operator: "", setOperator: () => {} });
export const useOperator = () => useContext(OperatorCtx);

export default function Providers({ children }: { children: React.ReactNode }) {
  const [operator, setOp] = useState("");
  useEffect(() => {
    try { setOp(localStorage.getItem("operator") || ""); } catch { /* storage unavailable */ }
  }, []);
  const value = useMemo(() => ({
    operator,
    setOperator: (s: string) => { setOp(s); try { localStorage.setItem("operator", s); } catch { /* ignore */ } },
  }), [operator]);
  return <ConvexProvider client={convex}><OperatorCtx.Provider value={value}>{children}</OperatorCtx.Provider></ConvexProvider>;
}
