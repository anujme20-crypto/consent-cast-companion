// Target-phone auto-answer: marks the session as active when the device picks
// up. Auto-answer means there is no Accept button on the phone — this fires
// the moment a ring arrives.
import { createFileRoute } from "@tanstack/react-router";
import {
  errorResponse,
  isUuid,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-cors";

async function handleAccept(request: Request): Promise<Response> {
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

  const { data: session } = await supabaseAdmin
    .from("voice_sessions")
    .select("id,status")
    .eq("id", body!.sessionId)
    .eq("device_id", device.id)
    .maybeSingle();
  if (!session) return errorResponse("session_not_found", 404);

  if (session.status === "ringing" || session.status === "accepted") {
    await supabaseAdmin
      .from("voice_sessions")
      .update({
        status: "active",
        accepted_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    return jsonResponse({ ok: true, status: "active" });
  }
  return jsonResponse({ ok: true, status: session.status });
}

export const Route = createFileRoute("/api/public/device/accept")({
  server: {
    handlers: {
      OPTIONS: () => optionsResponse(),
      POST: ({ request }) => handleAccept(request),
    },
  },
});
