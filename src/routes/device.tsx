import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { VoiceLink, type VoiceConnState } from "@/lib/voicelink-webrtc";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/device")({
  head: () => ({
    meta: [
      { title: "VoiceLink Target Phone" },
      {
        name: "description",
        content:
          "Target phone: pair once with the admin's code, then every call answers automatically and plays the admin's live voice.",
      },
      { property: "og:title", content: "VoiceLink Target Phone" },
      {
        property: "og:description",
        content:
          "Pair once with the admin's code — every call then answers automatically.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: DevicePage,
});

type Phase = "loading" | "pair" | "waiting" | "connecting" | "live";

const TOKEN_KEY = "vl_device_token";
const ID_KEY = "vl_device_id";
const NAME_KEY = "vl_device_name";

interface StoredDevice {
  token: string;
  id: string;
  name: string;
}

interface ActiveCall {
  sessionId: string;
  link: VoiceLink | null;
}

function DevicePage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const phaseRef = useRef<Phase>("loading");
  phaseRef.current = phase;
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needTap, setNeedTap] = useState(false);

  const deviceRef = useRef<StoredDevice | null>(null);
  deviceRef.current = device;
  const callRef = useRef<ActiveCall | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const wakeRef = useRef<{ release: () => Promise<void> } | null>(null);

  const clearCall = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    callRef.current = null;
    try {
      current.link?.close(false);
    } catch {
      // already torn down
    }
    void wakeRef.current?.release().catch(() => undefined);
    wakeRef.current = null;
  }, []);

  const playStream = useCallback((stream: MediaStream) => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = stream;
    el.play()
      .then(() => setNeedTap(false))
      .catch(() => setNeedTap(true));
  }, []);

  const startFromRing = useCallback(
    async (sessionId: string) => {
      const stored = deviceRef.current;
      if (!stored) return;
      if (callRef.current) {
        if (callRef.current.sessionId === sessionId) return;
        // A new ring replaces whatever call is running.
        clearCall();
      }
      const call: ActiveCall = { sessionId, link: null };
      callRef.current = call;
      setPhase("connecting");
      setError(null);
      // Auto-answer: no button — accept and open the audio link right away.
      try {
        await fetch("/api/public/device/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: stored.token, sessionId }),
        }).catch(() => undefined);
        const link = new VoiceLink({
          sessionId,
          role: "device",
          onState: (state) => {
            if (state === "live") {
              setPhase("live");
              void (async () => {
                try {
                  const nav = navigator as Navigator & {
                    wakeLock?: {
                      request: (type: string) => Promise<{
                        release: () => Promise<void>;
                      }>;
                    };
                  };
                  wakeRef.current = (await nav.wakeLock?.request("screen")) ?? null;
                } catch {
                  // wake lock unsupported — fine
                }
              })();
            } else if (state === "closed") {
              clearCall();
              setPhase("waiting");
            } else if (state === "failed") {
              clearCall();
              setPhase("waiting");
            }
          },
          onRemoteStream: playStream,
        });
        call.link = link;
        await link.connectDevice();
      } catch (err) {
        console.error("[device] call start failed", err);
        clearCall();
        setPhase("waiting");
      }
    },
    [clearCall, playStream],
  );

  // Load stored pairing on mount.
  useEffect(() => {
    try {
      const token = window.localStorage.getItem(TOKEN_KEY);
      const id = window.localStorage.getItem(ID_KEY);
      const name = window.localStorage.getItem(NAME_KEY);
      if (token && id) {
        setDevice({ token, id, name: name ?? "Target Phone" });
        setPhase("waiting");
      } else {
        setPhase("pair");
      }
    } catch {
      setPhase("pair");
    }
  }, []);

  // Realtime ring listener + heartbeat polling fallback.
  useEffect(() => {
    const stored = deviceRef.current;
    if (!stored) return;

    const channel = supabase
      .channel(`vl:dev:${stored.id}`)
      .on("broadcast", { event: "ring" }, ({ payload }) => {
        const sessionId =
          typeof payload?.sessionId === "string" ? payload.sessionId : null;
        if (sessionId) void startFromRing(sessionId);
      })
      .on("broadcast", { event: "cancel" }, () => {
        // Admin cancelled before the link opened.
        if (callRef.current && phaseRef.current !== "live") {
          clearCall();
          setPhase("waiting");
        }
      });
    channel.subscribe();

    let stopped = false;
    const tick = async () => {
      const current = deviceRef.current;
      if (!current || stopped) return;
      try {
        const res = await fetch("/api/public/device/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: current.token }),
        });
        if (res.status === 401) {
          // Token revoked or device re-paired — go back to pairing.
          window.localStorage.removeItem(TOKEN_KEY);
          window.localStorage.removeItem(ID_KEY);
          window.localStorage.removeItem(NAME_KEY);
          clearCall();
          setDevice(null);
          setPhase("pair");
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as {
          session: { id: string; status: string } | null;
        };
        if (
          data.session &&
          (data.session.status === "ringing" ||
            data.session.status === "accepted")
        ) {
          void startFromRing(data.session.id);
        } else if (data.session && data.session.status === "active") {
          void startFromRing(data.session.id);
        } else if (!data.session && callRef.current) {
          // Session vanished (admin replaced it) — drop the old link.
          clearCall();
          setPhase("waiting");
        }
      } catch {
        // Network hiccup — the next tick retries.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 5000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      void supabase.removeChannel(channel);
    };
  }, [device, clearCall, startFromRing]);

  const endCall = useCallback(async () => {
    const stored = deviceRef.current;
    const current = callRef.current;
    if (!stored || !current) return;
    try {
      await fetch("/api/public/device/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: stored.token, sessionId: current.sessionId }),
      });
    } catch {
      // Server already knows or is unreachable — hang up locally anyway.
    }
    clearCall();
    setPhase("waiting");
  }, [clearCall]);

  const unpair = useCallback(() => {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(ID_KEY);
    window.localStorage.removeItem(NAME_KEY);
    clearCall();
    setDevice(null);
    setPhase("pair");
  }, [clearCall]);

  return (
    <div className="min-h-dvh bg-background">
      <audio ref={audioRef} autoPlay playsInline className="hidden" />
      <div className="mx-auto flex min-h-dvh max-w-md flex-col p-4">
        {phase === "loading" ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">Loading…</p>
          </div>
        ) : phase === "pair" ? (
          <PairForm
            onPaired={(paired) => {
              setDevice(paired);
              setPhase("waiting");
            }}
            onError={setError}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
            <div
              className={`flex size-28 items-center justify-center rounded-full ${
                phase === "live"
                  ? "animate-pulse bg-chart-2/20"
                  : phase === "connecting"
                    ? "animate-pulse bg-chart-4/20"
                    : "bg-secondary"
              }`}
            >
              <span className="text-5xl" aria-hidden>
                {phase === "live" ? "🔊" : phase === "connecting" ? "📞" : "👂"}
              </span>
            </div>
            <div>
              <h1 className="text-2xl font-bold">
                {phase === "live"
                  ? "Live — listening"
                  : phase === "connecting"
                    ? "Connecting…"
                    : "Connected"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {phase === "live"
                  ? "The admin's voice plays here automatically."
                  : phase === "connecting"
                    ? "Answering the call automatically…"
                    : "Waiting for the admin to start speaking."}
              </p>
            </div>
            {needTap && phase === "live" ? (
              <Button
                size="lg"
                onClick={() => {
                  const el = audioRef.current;
                  if (!el) return;
                  el.play()
                    .then(() => setNeedTap(false))
                    .catch(() => setNeedTap(true));
                }}
              >
                Tap to start the speaker
              </Button>
            ) : null}
            {phase === "live" || phase === "connecting" ? (
              <Button variant="destructive" onClick={() => void endCall()}>
                End call
              </Button>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="mt-auto w-full space-y-2 pb-4 text-xs text-muted-foreground">
              <p>
                Paired as <span className="font-medium">{device?.name}</span>.
                Keep this screen open and the phone unlocked so calls come
                through.
              </p>
              <button
                className="underline underline-offset-2"
                onClick={unpair}
              >
                Unpair this phone
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PairForm({
  onPaired,
  onError,
}: {
  onPaired: (device: StoredDevice) => void;
  onError: (message: string | null) => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("Target Phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    onError(null);
    try {
      const res = await fetch("/api/public/device/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, name }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        const messages: Record<string, string> = {
          invalid_code: "That code doesn't look right — 6 letters/numbers.",
          code_not_found: "Code not found. Ask the admin for the current code.",
        };
        throw new Error(messages[data.error ?? ""] ?? "Pairing failed — try again.");
      }
      const data = (await res.json()) as { deviceId: string; token: string };
      window.localStorage.setItem(TOKEN_KEY, data.token);
      window.localStorage.setItem(ID_KEY, data.deviceId);
      window.localStorage.setItem(NAME_KEY, name.trim() || "Target Phone");
      onPaired({ token: data.token, id: data.deviceId, name: name.trim() || "Target Phone" });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Pairing failed — try again.";
      setError(message);
      onError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">VoiceLink</CardTitle>
          <p className="text-sm text-muted-foreground">
            Target phone — enter the admin's 6-character pairing code once.
            After that, every call answers automatically.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            maxLength={6}
            placeholder="Pairing code"
            className="text-center font-mono text-2xl uppercase tracking-[0.4em]"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <Input
            placeholder="Phone name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          <Button
            disabled={busy || code.length !== 6}
            onClick={() => void submit()}
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// Re-exported for the VoiceLink state type used above.
export type { VoiceConnState };
