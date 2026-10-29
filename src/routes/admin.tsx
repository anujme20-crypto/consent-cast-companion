import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  endVoiceSession,
  getAdminState,
  regeneratePairingCode,
  removeDevice,
  startVoiceSession,
} from "@/lib/voicelink-server";
import {
  VoiceLink,
  sendToDevice,
  type VoiceConnState,
} from "@/lib/voicelink-webrtc";
import type { VoiceStats } from "@/lib/voice-audio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "VoiceLink Admin" },
      {
        name: "description",
        content:
          "Admin panel: pair the target phone, start and control the live voice link.",
      },
      { property: "og:title", content: "VoiceLink Admin" },
      {
        property: "og:description",
        content:
          "Admin panel: pair the target phone, start and control the live voice link.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AdminPage,
});

interface AdminStateData {
  profile: { id: string; name: string | null; email: string | null } | null;
  pairingCode: string | null;
  devices: {
    id: string;
    name: string;
    status: string;
    last_seen: string | null;
    created_at: string;
  }[];
  lastSession: {
    id: string;
    device_id: string;
    status: string;
    started_at: string;
    accepted_at: string | null;
    ended_at: string | null;
    end_reason: string | null;
  } | null;
}

const CONN_LABEL: Record<VoiceConnState, string> = {
  idle: "Idle",
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  failed: "Connection failed",
  closed: "Call ended",
};

function relative(ts: string | null): string {
  if (!ts) return "never";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function AdminPage() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [data, setData] = useState<AdminStateData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [call, setCall] = useState<{ sessionId: string; deviceId: string } | null>(null);
  const [connState, setConnState] = useState<VoiceConnState>("idle");
  const [stats, setStats] = useState<VoiceStats | null>(null);
  const [muted, setMuted] = useState(false);

  const callRef = useRef<{ sessionId: string; deviceId: string } | null>(null);
  const linkRef = useRef<VoiceLink | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  callRef.current = call;

  useEffect(() => {
    let mounted = true;
    void supabase.auth.getSession().then(({ data: got }) => {
      if (!mounted) return;
      setSession(got.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession);
        setAuthReady(true);
      },
    );
    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const teardownCall = useCallback(
    (sessionId: string | null, notifyPeer: boolean, reason: string) => {
      const link = linkRef.current;
      linkRef.current = null;
      link?.close(notifyPeer);
      localStreamRef.current = null;
      setMuted(false);
      setStats(null);
      setConnState("idle");
      setCall(null);
      if (sessionId) {
        void endVoiceSession({ data: { sessionId, reason } }).catch(
          () => undefined,
        );
      }
    },
    [],
  );

  const handleConnState = useCallback(
    (state: VoiceConnState) => {
      setConnState(state);
      const current = callRef.current;
      if ((state === "closed" || state === "failed") && current) {
        linkRef.current = null;
        localStreamRef.current = null;
        setMuted(false);
        setStats(null);
        setCall(null);
        setConnState("idle");
        void endVoiceSession({
          data: { sessionId: current.sessionId, reason: state },
        }).catch(() => undefined);
      }
    },
    [],
  );

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      const got = await getAdminState();
      setData(got as AdminStateData);
      // Admin-side safety net: if the session row says ended (device hung up
      // via its API or a replacement), drop the local WebRTC link.
      const current = callRef.current;
      const last = (got as AdminStateData).lastSession;
      if (
        current &&
        last &&
        last.id === current.sessionId &&
        last.status === "ended"
      ) {
        teardownCall(current.sessionId, false, "admin");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load data");
    }
  }, [session, teardownCall]);

  useEffect(() => {
    if (!session) {
      setData(null);
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [session, refresh]);

  useEffect(
    () => () => {
      // Unmount while a call is live: end it silently.
      const link = linkRef.current;
      const current = callRef.current;
      linkRef.current = null;
      link?.close(false);
      if (current) {
        void endVoiceSession({
          data: { sessionId: current.sessionId, reason: "admin" },
        }).catch(() => undefined);
      }
    },
    [],
  );

  const startCall = useCallback(
    async (deviceId: string, adminName: string) => {
      if (!session || busy) return;
      setBusy(true);
      setError(null);
      try {
        // Replace any previous link/session before ringing again.
        const previous = callRef.current;
        if (previous) {
          const old = linkRef.current;
          linkRef.current = null;
          old?.close(false);
          await endVoiceSession({
            data: { sessionId: previous.sessionId, reason: "replaced" },
          }).catch(() => undefined);
        }
        const started = await startVoiceSession({ data: { deviceId } });
        const next = { sessionId: started.id, deviceId };
        setCall(next);
        callRef.current = next;
        await sendToDevice(deviceId, "ring", {
          sessionId: started.id,
          adminName,
        });
        const link = new VoiceLink({
          sessionId: started.id,
          role: "admin",
          onState: handleConnState,
          onStats: setStats,
          onLocalStream: (stream) => {
            localStreamRef.current = stream;
          },
        });
        linkRef.current = link;
        await link.connectAdmin();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not start the call";
        setError(message);
        const current = callRef.current;
        if (current) teardownCall(current.sessionId, false, "failed");
      } finally {
        setBusy(false);
      }
    },
    [busy, handleConnState, session, teardownCall],
  );

  const endCall = useCallback(() => {
    const current = callRef.current;
    if (!current) return;
    teardownCall(current.sessionId, true, "admin");
  }, [teardownCall]);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
    setMuted(next);
  }, [muted]);

  if (!authReady) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!session) return <AdminLogin />;

  const adminName =
    data?.profile?.name || data?.profile?.email?.split("@")[0] || "Admin";
  const inCall = call !== null;
  const callDevice = data?.devices.find((d) => d.id === call?.deviceId);

  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex max-w-md flex-col gap-4 p-4 pb-10">
        <header className="flex items-center justify-between pt-2">
          <div>
            <h1 className="text-xl font-bold tracking-tight">VoiceLink</h1>
            <p className="text-xs text-muted-foreground">
              {data?.profile?.email ?? session.user.email ?? "Admin panel"}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (call) teardownCall(call.sessionId, true, "admin");
              void supabase.auth.signOut();
            }}
          >
            Sign out
          </Button>
        </header>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pairing code</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between gap-3">
            <div>
              <p className="font-mono text-3xl font-bold tracking-[0.3em] text-primary">
                {data?.pairingCode ?? "······"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                On the target phone, open <span className="font-mono">/device</span>{" "}
                and enter this code once.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void regeneratePairingCode()
                  .then(() => refresh())
                  .finally(() => setBusy(false));
              }}
            >
              New code
            </Button>
          </CardContent>
        </Card>

        {inCall ? (
          <Card className="border-primary/40">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <span
                  className={`inline-block size-2.5 rounded-full ${
                    connState === "live"
                      ? "animate-pulse bg-chart-2"
                      : connState === "failed"
                        ? "bg-destructive"
                        : "animate-pulse bg-chart-4"
                  }`}
                />
                {callDevice?.name ?? "Target phone"} ·{" "}
                {CONN_LABEL[connState]}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {stats ? (
                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">quality: {stats.quality}</Badge>
                  {stats.rttMs !== null ? (
                    <Badge variant="secondary">
                      delay: {Math.round(stats.rttMs)} ms
                    </Badge>
                  ) : null}
                  {stats.lossPct !== null ? (
                    <Badge variant="secondary">
                      loss: {stats.lossPct.toFixed(1)}%
                    </Badge>
                  ) : null}
                  {stats.bitrateKbps !== null ? (
                    <Badge variant="secondary">
                      {stats.bitrateKbps.toFixed(0)} kbps
                    </Badge>
                  ) : null}
                </div>
              ) : connState !== "live" ? (
                <p className="text-xs text-muted-foreground">
                  Ringing the target phone — it answers automatically.
                </p>
              ) : null}
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={toggleMute}>
                  {muted ? "Unmute mic" : "Mute mic"}
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={endCall}
                >
                  End voice
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Target phones</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {data?.devices.length ? (
              data.devices.map((device) => (
                <div
                  key={device.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{device.name}</p>
                    <p className="text-xs text-muted-foreground">
                      <Badge
                        variant={device.status === "active" ? "secondary" : "destructive"}
                        className="mr-1"
                      >
                        {device.status}
                      </Badge>
                      last seen {relative(device.last_seen)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    {!inCall ? (
                      <Button
                        size="sm"
                        disabled={busy || device.status !== "active"}
                        onClick={() => void startCall(device.id, adminName)}
                      >
                        Start voice
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || inCall}
                      onClick={() => {
                        setBusy(true);
                        void removeDevice({ data: { deviceId: device.id } })
                          .then(() => refresh())
                          .catch((err) =>
                            setError(
                              err instanceof Error
                                ? err.message
                                : "Could not remove device",
                            ),
                          )
                          .finally(() => setBusy(false));
                      }}
                      aria-label={`Remove ${device.name}`}
                    >
                      ✕
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                No phone paired yet. Share the pairing code above with the
                target phone.
              </p>
            )}
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground">
          The target phone answers automatically — no button press needed there.
        </p>
      </div>
    </div>
  );
}

function AdminLogin() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      if (mode === "signup") {
        const { data: signed, error: err } = await supabase.auth.signUp({
          email,
          password,
        });
        if (err) throw err;
        if (signed.session) {
          setInfo("Account created — you are signed in.");
        } else {
          setInfo(
            "Account created. Check the email inbox for a confirmation link, then sign in here.",
          );
        }
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (err) throw err;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl font-bold">VoiceLink</CardTitle>
          <p className="text-sm text-muted-foreground">
            Admin panel — sign in to control the live voice link.
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            placeholder="Password (6+ characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
          {info ? <p className="text-sm text-chart-2">{info}</p> : null}
          <Button disabled={busy || !email || !password} onClick={() => void submit()}>
            {busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setInfo(null);
            }}
          >
            {mode === "signin"
              ? "New here? Create an admin account"
              : "Already have an account? Sign in"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
