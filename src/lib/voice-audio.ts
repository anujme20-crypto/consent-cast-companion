// Low-bandwidth voice profile shared by the admin phone and the target phone.
// Goal: clear voice even on weak 3G / 2G-class connections.

export const VOICE_AUDIO_PROFILE = {
  /** Cap Opus at 16 kbps — mono speech stays understandable at this rate. */
  opusMaxAverageBitrate: 16000,
  /** In-band forward error correction repairs packets lost on bad networks. */
  opusUseInbandFec: true,
  /** Discontinuous transmission: send silence as nothing, saving bandwidth. */
  opusUseDtx: true,
  opusStereo: false,
  /** Adaptive bitrate range when the network degrades or recovers. */
  minBitrate: 8000,
  maxBitrate: 24000,
} as const;

export const MIC_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

function fmtpParams(): string {
  return [
    `maxaveragebitrate=${VOICE_AUDIO_PROFILE.opusMaxAverageBitrate}`,
    `usedtx=${VOICE_AUDIO_PROFILE.opusUseDtx ? 1 : 0}`,
    `useinbandfec=${VOICE_AUDIO_PROFILE.opusUseInbandFec ? 1 : 0}`,
    `stereo=${VOICE_AUDIO_PROFILE.opusStereo ? 1 : 0}`,
  ].join(";");
}

/**
 * Adds the low-bandwidth Opus parameters to an SDP offer/answer so both sides
 * agree on a small, error-resilient bitrate. Idempotent.
 */
export function mungeSdpForLowBandwidth(sdp: string): string {
  if (!sdp) return sdp;
  const payloadType = /a=rtpmap:(\d+)\s+opus\/48000\/2/.exec(sdp)?.[1];
  if (!payloadType) return sdp;
  const params = fmtpParams();
  const fmtpRe = new RegExp(`a=fmtp:${payloadType} ?([^\\r\\n]*)`);
  const existing = fmtpRe.exec(sdp)?.[1];
  if (existing !== undefined) {
    const merged = existing.includes("maxaveragebitrate")
      ? existing
      : existing
        ? `${existing};${params}`
        : params;
    return sdp.replace(fmtpRe, `a=fmtp:${payloadType} ${merged}`);
  }
  const rtpmapRe = new RegExp(`(a=rtpmap:${payloadType} opus/48000/2\\r?\\n)`);
  return sdp.replace(rtpmapRe, `$1a=fmtp:${payloadType} ${params}\r\n`);
}

export type VoiceQuality = "good" | "ok" | "poor" | "unknown";

export interface VoiceStats {
  rttMs: number | null;
  jitterMs: number | null;
  lossPct: number | null;
  bitrateKbps: number | null;
  quality: VoiceQuality;
}

export function gradeQuality(
  lossPct: number | null,
  rttMs: number | null,
  hasAudio: boolean,
): VoiceQuality {
  if (!hasAudio) return "unknown";
  if (lossPct === null && rttMs === null) return "unknown";
  if ((lossPct ?? 0) > 8 || (rttMs ?? 0) > 600) return "poor";
  if ((lossPct ?? 0) > 3 || (rttMs ?? 0) > 300) return "ok";
  return "good";
}

/**
 * Adaptive bitrate decision: step the Opus sender bitrate down when the
 * network is struggling and back up when it recovers. Returns the new cap,
 * or null when no change is needed.
 */
export function nextSenderBitrate(
  current: number,
  quality: VoiceQuality,
): number | null {
  const target =
    quality === "poor"
      ? VOICE_AUDIO_PROFILE.minBitrate
      : quality === "ok"
        ? VOICE_AUDIO_PROFILE.opusMaxAverageBitrate
        : quality === "good"
          ? VOICE_AUDIO_PROFILE.maxBitrate
          : null;
  if (target === null || target === current) return null;
  return target;
}
