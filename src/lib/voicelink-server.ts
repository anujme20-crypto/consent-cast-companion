// Admin-side server functions (run with the signed-in admin's RLS context).
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < 6; i += 1) {
    code += PAIRING_ALPHABET[Math.floor(Math.random() * PAIRING_ALPHABET.length)];
  }
  return code;
}

export const getAdminState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    let { data: profile } = await supabase
      .from("profiles")
      .select("id,name,email")
      .eq("id", userId)
      .maybeSingle();
    if (!profile) {
      const { data: created } = await supabase
        .from("profiles")
        .insert({ id: userId })
        .select("id,name,email")
        .single();
      profile = created;
    }

    let { data: settings } = await supabase
      .from("admin_settings")
      .select("pairing_code")
      .eq("user_id", userId)
      .maybeSingle();
    if (!settings) {
      const { data: created } = await supabase
        .from("admin_settings")
        .insert({ user_id: userId, pairing_code: generatePairingCode() })
        .select("pairing_code")
        .single();
      settings = created;
    }

    const { data: devices } = await supabase
      .from("devices")
      .select("id,name,status,last_seen,created_at")
      .eq("admin_id", userId)
      .order("created_at", { ascending: false });

    const { data: lastSession } = await supabase
      .from("voice_sessions")
      .select(
        "id,device_id,status,started_at,accepted_at,ended_at,end_reason",
      )
      .eq("admin_id", userId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    return {
      profile,
      pairingCode: settings?.pairing_code ?? null,
      devices: devices ?? [],
      lastSession: lastSession ?? null,
    };
  });

export const startVoiceSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { deviceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: device } = await supabase
      .from("devices")
      .select("id,status")
      .eq("id", data.deviceId)
      .eq("admin_id", userId)
      .maybeSingle();
    if (!device || device.status !== "active") {
      throw new Error("Target phone is not paired");
    }
    // Retire any lingering session before ringing again.
    await supabase
      .from("voice_sessions")
      .update({
        status: "ended",
        ended_at: new Date().toISOString(),
        end_reason: "replaced",
      })
      .eq("admin_id", userId)
      .in("status", ["ringing", "active"]);
    const { data: session, error } = await supabase
      .from("voice_sessions")
      .insert({ admin_id: userId, device_id: data.deviceId, status: "ringing" })
      .select("id,status,started_at")
      .single();
    if (error || !session) throw new Error("Could not start the call");
    return session;
  });

export const endVoiceSession = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sessionId: string; reason?: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await supabase
      .from("voice_sessions")
      .update({
        status: "ended",
        ended_at: new Date().toISOString(),
        end_reason: data.reason ?? "admin",
      })
      .eq("id", data.sessionId)
      .eq("admin_id", userId);
    return { ok: true };
  });

export const regeneratePairingCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { data, error } = await supabase
        .from("admin_settings")
        .update({ pairing_code: generatePairingCode(), updated_at: new Date().toISOString() })
        .eq("user_id", userId)
        .select("pairing_code")
        .single();
      if (!error && data) return { pairingCode: data.pairing_code };
    }
    throw new Error("Could not regenerate the pairing code");
  });

export const removeDevice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { deviceId: string }) => input)
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    await supabase.from("devices").delete().eq("id", data.deviceId).eq("admin_id", userId);
    return { ok: true };
  });
