"""Ask StockLens end to end: real Claude calls through the Convex action, real Convex data, multi-turn context and citations.
Needs ANTHROPIC_API_KEY set on the Convex deployment. Prints answers for human review and checks structural properties."""
import sys, time
from convex import ConvexClient
c = ConvexClient("http://127.0.0.1:3210")
ok = lambda cond, m: print(("PASS " if cond else "FAIL ") + m) or (cond or sys.exit(1))

def ask(conv, q):
    t = time.time()
    c.action("assistant:send", {"conversationId": conv, "text": q, "operator": "Test Operator"})
    m = c.query("assistantData:thread", {"conversationId": conv})["messages"][-1]
    print(f"\n> {q}   ({time.time() - t:.0f}s, tools: {[s['tool'] for s in m['steps']]})\n{m['text'] or m.get('error')}\n refs: {[r['label'] for r in m['refs']]} invalid: {m.get('invalidRefs')}")
    return m

conv = c.mutation("assistantData:startConversation", {"operator": "Test Operator"})
m1 = ask(conv, "Why is Shelf 2 missing one utensil package?")
ok(m1["status"] == "done" and any(r["kind"] == "event" for r in m1["refs"]), "explains Shelf 2 with a clickable camera event")
ok("7" in m1["text"] and "8" in m1["text"], "states recorded 8 vs physical 7")
m2 = ask(conv, "Where was it seen afterward?")
ok(m2["status"] == "done", "follow-up answered using conversation context")
m3 = ask(conv, "Show me the footage.")
ev = [r for r in m3["refs"] if r["kind"] == "event"]
ok(bool(ev) and ev[0].get("videoUrl") and ev[0].get("t") is not None, "footage reference carries clip url and timestamp")

conv2 = c.mutation("assistantData:startConversation", {"operator": "Test Operator", "context": {"kind": "incident", "ref": "INC-103", "label": "Unrecorded movement · Dispatch dock"}})
m4 = ask(conv2, "Explain this incident and what I should do.")
ok(m4["status"] == "done" and any(r["key"] == "inc:INC-103" or r["kind"] == "event" for r in m4["refs"]), "incident context is used")
m5 = ask(conv2, "Has anything been placed on the wrong shelf?")
ok(m5["status"] == "done", "misplacement question answered from incident data")
m6 = ask(conv2, "How many water bottles are on Shelf 1?")
ok("12" in m6["text"], "Shelf 1 quantity answered from records/estimate")
print("\nALL ASSISTANT TESTS PASSED")
