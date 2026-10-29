// Target-phone hang-up: the person holding the target phone can end the
// session themselves.
import { createFileRoute } from "@tanstack/react-router";
import {
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-cors";

async function handleEnd(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    token?: unknown;
    sessionId?: unknown;
  } | null;
  if (!isUuid(body?.token) || !isUuid(body?.sessionId)) {
    return errorResponse("unauthorized", 401);
  }

  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );
  const { data: device } = await supabaseAdmin
    .from("devices")
    .select("id,status")
    .eq("token", body!.token)
    .maybeSingle();
  if (!device || device.status !== "active") {
    return errorResponse("unauthorized", 401);
  }

  await supabaseAdmin
    .from("voice_sessions")
    .update({
      status: "ended",
      ended_at: new Date().toISOString(),
      end_reason: "device",
    })
    .eq("id", body!.sessionId)
    .eq("device_id", device.id)
    .in("status", ["ringing", "accepted", "active"]);
  return jsonResponse({ ok: true });
}

export const Route = createFileRoute("/api/public/device/end")({
  server: {
    handlers: {
      OPTIONS: () => optionsResponse(),
      POST: ({ request }) => handleEnd(request),
    },
  },
});
