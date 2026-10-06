/**
 * Minimal microphone tap for calibration: raw mono frames, processing disabled
 * where the browser allows it, nothing leaves the page.
 */
export interface MicTap {
  ctx: AudioContext;
  settings: MediaTrackSettings;
  label: string;
  close(): void;
}

export async function openMicTap(onChunk: (x: Float32Array) => void): Promise<MicTap> {
  const ctx = new AudioContext();
  void ctx.resume();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
  } catch (e) {
    void ctx.close();
    throw e;
  }
  const source = ctx.createMediaStreamSource(stream);
  const sp = ctx.createScriptProcessor(2048, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
  source.connect(sp).connect(sink).connect(ctx.destination);
  const track = stream.getAudioTracks()[0];
  return {
    ctx,
    settings: track?.getSettings?.() ?? {},
    label: track?.label ?? "",
    close: () => {
      sp.onaudioprocess = null;
      source.disconnect();
      sp.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
    },
  };
}
