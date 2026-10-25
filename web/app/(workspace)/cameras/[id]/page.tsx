import { redirect } from "next/navigation";

export default async function CameraRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/cameras?cam=${encodeURIComponent(id)}`);
}
