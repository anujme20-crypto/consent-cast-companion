// Target-phone heartbeat + current-session lookup. The device polls this every
// few seconds; it doubles as the ring fallback when a realtime broadcast is
// missed on a slow network.
import { createFileRoute } from "@tanstack/react-router";
import {
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-cors";

async function handleSession(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
  } | null;
  if (!isUuid(body?.token)) return errorResponse("unauthorized", 401);

  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );
  const { data: device } = await supabaseAdmin
    .from("devices")
    .select("id,name,status")
    .eq("token", body!.token)
    .maybeSingle();
  if (!device || device.status !== "active") {
    return errorResponse("unauthorized", 401);
  }

  await supabaseAdmin
    .from("devices")
    .update({ last_seen: new Date().toISOString() })
    .eq("id", device.id);

  const { data: session } = await supabaseAdmin
    .from("voice_sessions")
    .select("id,status")
    .eq("device_id", device.id)
    .in("status", ["ringing", "accepted", "active"])
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return jsonResponse({
    device: { id: device.id, name: device.name, status: device.status },
    session: session ? { id: session.id, status: session.status } : null,
  });
}

export const Route = createFileRoute("/api/public/device/session")({
  server: {
    handlers: {
      OPTIONS: () => optionsResponse(),
      POST: ({ request }) => handleSession(request),
    },
  },
});
