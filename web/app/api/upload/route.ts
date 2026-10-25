import { NextResponse } from "next/server";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Local-deployment helper: stores an uploaded recording where the CV worker can read it (../data/uploads).
export async function POST(req: Request) {
  // the hosted demo has no CV worker and no writable disk; uploads only make sense next to a local worker
  if (process.env.VERCEL) return NextResponse.json({ error: "Uploading footage needs a local CV worker; it is disabled on the hosted demo." }, { status: 501 });
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "no file" }, { status: 400 });
  if (!/\.(mp4|mov|m4v)$/i.test(file.name)) return NextResponse.json({ error: "upload an MP4/MOV recording" }, { status: 400 });
  if (file.size > 500 * 1024 * 1024) return NextResponse.json({ error: "file larger than 500 MB" }, { status: 400 });
  const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.resolve(process.cwd(), "..", "data", "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, safe), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ uri: `data/uploads/${safe}` });
}
