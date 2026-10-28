// WebRTC mic-to-speaker link used by both phones.
// Signaling runs over Supabase Realtime broadcast channels; the audio itself
// is peer-to-peer and tuned for slow networks (see voice-audio.ts).
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  MIC_CONSTRAINTS,
  VOICE_AUDIO_PROFILE,
  gradeQuality,
  mungeSdpForLowBandwidth,
  nextSenderBitrate,
  type VoiceQuality,
  type VoiceStats,
} from "./voice-audio";

export type VoiceRole = "admin" | "device";
export type VoiceConnState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "failed"
  | "closed";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
];

const OFFER_RETRY_MS = 1500;
const OFFER_MAX_TRIES = 8;

type SignalBody =
  | { kind: "offer" | "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "bye" };

type Signal = SignalBody & { role: VoiceRole };

export interface VoiceLinkOptions {
  sessionId: string;
  role: VoiceRole;
  onState: (state: VoiceConnState) => void;
  onStats?: (stats: VoiceStats) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onLocalStream?: (stream: MediaStream) => void;
}

export class VoiceLink {
  private pc: RTCPeerConnection | null = null;
  private channel: RealtimeChannel | null = null;
  private statsTimer: number | null = null;
  private offerTimer: number | null = null;
  private localStream: MediaStream | null = null;
  private remoteAnswered = false;
  private offerAttempts = 0;
  private reconnects = 0;
  private closed = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private lastBytes = 0;
  private lastBytesTs = 0;
  private currentBitrate: number = VOICE_AUDIO_PROFILE.opusMaxAverageBitrate;

  constructor(private opts: VoiceLinkOptions) {}

  /** Admin side: open the signaling channel, capture mic, send the offer. */
  async connectAdmin(): Promise<void> {
    this.opts.onState("connecting");
    this.channel = await this.openChannel();
    const pc = this.ensurePeer();
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS,
      video: false,
    });
    this.opts.onLocalStream?.(this.localStream);
    for (const track of this.localStream.getAudioTracks()) {
      pc.addTrack(track, this.localStream);
    }
    await this.sendOffer();
  }

  /** Target phone side: open the channel and wait for the admin's offer. */
  async connectDevice(): Promise<void> {
    this.opts.onState("connecting");
    this.channel = await this.openChannel();
    this.ensurePeer();
  }

  /** End the call and notify the peer. */
  close(notifyPeer = true): void {
    if (notifyPeer) this.send({ kind: "bye" });
    this.teardown();
    this.opts.onState("closed");
  }

  private async openChannel(): Promise<RealtimeChannel> {
    const channel = supabase
      .channel(`vl:ses:${this.opts.sessionId}`, {
        config: { broadcast: { self: false, ack: false } },
      })
      .on("broadcast", { event: "sig" }, ({ payload }) => {
        void this.handleSignal(payload as Signal);
      });
    const subscribed = new Promise<boolean>((resolve) => {
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") resolve(true);
      });
    });
    const ok = await Promise.race([
      subscribed,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
    if (!ok) throw new Error("Signaling channel could not connect");
    return channel;
  }

  private send(payload: SignalBody): void {
    void this.channel?.send({
      type: "broadcast",
      event: "sig",
      payload: { ...payload, role: this.opts.role },
    });
  }

  private ensurePeer(): RTCPeerConnection {
    if (
      this.pc &&
      this.pc.connectionState !== "failed" &&
      this.pc.connectionState !== "closed"
    ) {
      return this.pc;
    }
    const pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
    });
    this.pc = pc;
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ kind: "ice", candidate: candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) this.opts.onRemoteStream?.(stream);
    };
    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case "connected":
          this.opts.onState("live");
          break;
        case "disconnected":
          this.opts.onState("reconnecting");
          break;
        case "failed":
          void this.handleFailure();
          break;
      }
    };
    return pc;
  }

  private async handleSignal(signal: Signal): Promise<void> {
    if (this.closed || !signal || signal.role === this.opts.role) return;
    try {
      if (signal.kind === "offer") {
        if (this.opts.role !== "device") return;
        const pc = this.ensurePeer();
        if (pc.signalingState !== "stable") return;
        await pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        this.flushPendingIce(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription({
          type: "answer",
          sdp: mungeSdpForLowBandwidth(answer.sdp ?? ""),
        });
        this.send({ kind: "answer", sdp: pc.localDescription!.sdp });
        this.startStats();
      } else if (signal.kind === "answer") {
        if (this.opts.role !== "admin") return;
        const pc = this.pc;
        if (!pc || pc.signalingState !== "have-local-offer") return;
        await pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
        this.flushPendingIce(pc);
        this.remoteAnswered = true;
        this.stopOfferRetry();
        this.startStats();
      } else if (signal.kind === "ice") {
        const pc = this.pc;
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(signal.candidate).catch(() => undefined);
        } else {
          this.pendingIce.push(signal.candidate);
        }
      } else if (signal.kind === "bye") {
        this.teardown();
        this.opts.onState("closed");
      }
    } catch (error) {
      console.error("[VoiceLink] signaling error", error);
    }
  }

  private flushPendingIce(pc: RTCPeerConnection): void {
    for (const candidate of this.pendingIce.splice(0)) {
      void pc.addIceCandidate(candidate).catch(() => undefined);
    }
  }

  private async sendOffer(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed || this.remoteAnswered) return;
    if (pc.signalingState === "stable" && !pc.localDescription) {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
      });
      await pc.setLocalDescription({
        type: "offer",
        sdp: mungeSdpForLowBandwidth(offer.sdp ?? ""),
      });
    }
    if (pc.signalingState !== "stable") return;
    this.send({ kind: "offer", sdp: pc.localDescription!.sdp });
    this.offerAttempts += 1;
    if (this.offerAttempts >= OFFER_MAX_TRIES) {
      this.opts.onState("failed");
      return;
    }
    this.offerTimer = window.setTimeout(() => void this.sendOffer(), OFFER_RETRY_MS);
  }

  private stopOfferRetry(): void {
    if (this.offerTimer !== null) {
      window.clearTimeout(this.offerTimer);
      this.offerTimer = null;
    }
  }

  private async handleFailure(): Promise<void> {
    if (this.closed) return;
    if (this.opts.role !== "admin" || this.reconnects >= 2) {
      this.opts.onState("failed");
      return;
    }
    this.reconnects += 1;
    this.opts.onState("reconnecting");
    const stream = this.localStream;
    try {
      this.pc?.close();
    } catch {
      // ignore
    }
    this.pc = null;
    this.remoteAnswered = false;
    this.offerAttempts = 0;
    this.pendingIce = [];
    if (stream) {
      const pc = this.ensurePeer();
      for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      await this.sendOffer();
    } else {
      this.opts.onState("failed");
    }
  }

  private startStats(): void {
    if (this.statsTimer !== null || !this.opts.onStats) return;
    this.statsTimer = window.setInterval(() => void this.sampleStats(), 2000);
  }

  private async sampleStats(): Promise<void> {
    const pc = this.pc;
    if (!pc || this.closed) return;
    const report = await pc.getStats();
    interface StatShape {
      type: string;
      kind?: string;
      jitter?: number;
      packetsLost?: number;
      packetsReceived?: number;
      bytesReceived?: number;
      bytesSent?: number;
      state?: string;
      currentRoundTripTime?: number;
    }
    let jitterMs: number | null = null;
    let lossPct: number | null = null;
    let rttMs: number | null = null;
    let bytes = 0;
    let hasAudio = false;
    report.forEach((raw) => {
      const stat = raw as unknown as StatShape;
      if (stat.type === "inbound-rtp" && stat.kind === "audio") {
        hasAudio = true;
        if (typeof stat.jitter === "number") jitterMs = stat.jitter * 1000;
        const lost = typeof stat.packetsLost === "number" ? stat.packetsLost : 0;
        const received =
          typeof stat.packetsReceived === "number" ? stat.packetsReceived : 0;
        if (received + lost > 0) lossPct = (lost / (received + lost)) * 100;
        if (typeof stat.bytesReceived === "number") bytes = stat.bytesReceived;
      }
      if (
        stat.type === "outbound-rtp" &&
        stat.kind === "audio" &&
        typeof stat.bytesSent === "number"
      ) {
        bytes = stat.bytesSent;
      }
      if (
        stat.type === "candidate-pair" &&
        stat.state === "succeeded" &&
        typeof stat.currentRoundTripTime === "number"
      ) {
        rttMs = stat.currentRoundTripTime * 1000;
      }
    });
    const now = Date.now();
    let bitrateKbps: number | null = null;
    if (bytes > 0 && this.lastBytesTs > 0 && now > this.lastBytesTs) {
      bitrateKbps =
        ((bytes - this.lastBytes) * 8) / ((now - this.lastBytesTs) / 1000) / 1000;
    }
    if (bytes > 0) {
      this.lastBytes = bytes;
      this.lastBytesTs = now;
    }
    const quality = gradeQuality(lossPct, rttMs, hasAudio);
    if (this.opts.role === "admin") void this.adaptBitrate(quality);
    this.opts.onStats?.({ rttMs, jitterMs, lossPct, bitrateKbps, quality });
  }

  private async adaptBitrate(quality: VoiceQuality): Promise<void> {
    const next = nextSenderBitrate(this.currentBitrate, quality);
    if (next === null) return;
    this.currentBitrate = next;
    const sender = this.pc
      ?.getSenders()
      .find((s) => s.track?.kind === "audio");
    if (!sender) return;
    const params = sender.getParameters();
    if (params.encodings && params.encodings.length > 0) {
      params.encodings[0] = { ...params.encodings[0], maxBitrate: next };
    } else {
      params.encodings = [{ maxBitrate: next }];
    }
    try {
      await sender.setParameters(params);
    } catch {
      // Older browsers may refuse; the SDP cap still holds.
    }
  }

  private teardown(): void {
    this.closed = true;
    this.stopOfferRetry();
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    try {
      this.pc?.close();
    } catch {
      // ignore
    }
    this.pc = null;
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }
}

/**
 * Fire-and-forget broadcast to the target phone's personal channel
 * (ring / cancel events). Resolves even if the phone is unreachable.
 */
export function sendToDevice(
  deviceId: string,
  event: "ring" | "cancel",
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
      setTimeout(() => void supabase.removeChannel(channel), 200);
    };
    const channel = supabase.channel(`vl:dev:${deviceId}`);
    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        void channel
          .send({ type: "broadcast", event, payload })
          .catch(() => undefined)
          .then(() => finish());
      }
    });
    setTimeout(finish, 4000);
  });
}
