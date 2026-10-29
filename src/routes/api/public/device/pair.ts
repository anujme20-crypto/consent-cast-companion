// Target-phone pairing endpoint. The target phone is NOT signed in; it proves
// it belongs to an admin by presenting that admin's 6-character pairing code.
// Returns a device id + secret token used by all later device calls.
import { createFileRoute } from "@tanstack/react-router";
import {
  CORS_HEADERS,
  errorResponse,
  jsonResponse,
  optionsResponse,
} from "@/lib/api-cors";

const PAIRING_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

async function handlePair(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    code?: unknown;
    name?: unknown;
  } | null;
  const code =
    typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  const name =
    typeof body?.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 40)
      : "Target Phone";
  if (!PAIRING_CODE_RE.test(code)) {
    return errorResponse("invalid_code", 400);
  }

  const { supabaseAdmin } = await import(
    "@/integrations/supabase/client.server"
  );
  const { data: settings } = await supabaseAdmin
    .from("admin_settings")
    .select("user_id")
    .eq("pairing_code", code)
    .maybeSingle();
  if (!settings) return errorResponse("code_not_found", 404);

  const token = crypto.randomUUID();
  const now = new Date().toISOString();

  // One target phone per admin profile (unique user_id). Re-pairing rotates
  // the token and re-activates the existing device row.
  const { data: existing } = await supabaseAdmin
    .from("devices")
    .select("id")
    .eq("user_id", settings.user_id)
    .maybeSingle();
  if (existing) {
    const { error } = await supabaseAdmin
      .from("devices")
      .update({ token, name, status: "active", last_seen: now })
      .eq("id", existing.id);
    if (error) return errorResponse("pair_failed", 500);
    return jsonResponse({ deviceId: existing.id, token });
  }

  const { data: device, error } = await supabaseAdmin
    .from("devices")
    .insert({
      admin_id: settings.user_id,
      user_id: settings.user_id,
      name,
      token,
      last_seen: now,
    })
    .select("id")
    .single();
  if (error || !device) return errorResponse("pair_failed", 500);
  return jsonResponse({ deviceId: device.id, token });
}

export const Route = createFileRoute("/api/public/device/pair")({
  server: {
    handlers: {
      OPTIONS: () => optionsResponse(),
      POST: ({ request }) => handlePair(request),
    },
  },
});

// Keep the CORS import referenced for readers of this file's contract.
void CORS_HEADERS;
