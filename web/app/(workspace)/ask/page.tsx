"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ago } from "@/lib/format";
import { ChatThread } from "../../components/Chat";
import { useOperator } from "../../providers";

/** Full-page Ask StockLens (workspace). Evidence clips open the surveillance view at the right camera and second. */
function Ask() {
  const params = useSearchParams();
  const router = useRouter();
  const { operator } = useOperator();
  const convs = useQuery(api.assistantData.conversations);
  const start = useMutation(api.assistantData.startConversation);
  const [convId, setConvId] = useState<Id<"conversations"> | null>((params.get("c") as Id<"conversations">) ?? null);
  const started = useRef(false);
  useEffect(() => {
    const ctx = params.get("context");
    if (!ctx || started.current || !operator) return;
    started.current = true;
    const [kind, ...rest] = ctx.split(":");
    start({ operator, context: { kind, ref: rest.join(":"), label: params.get("label") ?? rest.join(":") } }).then((id) => { setConvId(id); router.replace(`/ask?c=${id}`); });
  }, [params, operator, start, router]);
  useEffect(() => { const c = params.get("c"); if (c) setConvId(c as Id<"conversations">); }, [params]);
  const pick = (id: Id<"conversations"> | null) => { setConvId(id); router.replace(id ? `/ask?c=${id}` : "/ask"); };
  return (
    <div className="ask">
      <aside className="ask-rail">
        <button className="ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => pick(null)}>New conversation</button>
        <div className="tiny faint" style={{ margin: "18px 4px 6px" }}>Recent</div>
        {(convs ?? []).map((c) => (
          <button key={c._id} className={`conv ${c._id === convId ? "on" : ""}`} onClick={() => pick(c._id)}>
            <span className="ct">{c.title}</span><span className="tiny faint">{c.context ? `${c.context.kind} · ` : ""}{ago(c.updatedAt)}</span>
          </button>
        ))}
      </aside>
      <ChatThread convId={convId} onConversation={(id) => pick(id)}
        onClip={(r) => { if (r.cameraId) router.push(`/?cam=${r.cameraId}&t=${(r.t ?? 0).toFixed(1)}${convId ? `&chat=${convId}` : ""}`); else if (r.videoUrl) window.open(r.videoUrl, "_blank"); }} />
    </div>
  );
}

export default function Page() { return <Suspense><Ask /></Suspense>; }
