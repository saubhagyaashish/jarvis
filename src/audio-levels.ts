// Loudness meters for the avatar: how loud Jarvis's reply is (lip-sync) and
// how loud the user's mic is (the listening glow). One shared AudioContext,
// created from a user gesture so browsers allow it to run.

let context: AudioContext | null = null;

/** The shared AudioContext, created on first use; null if unsupported. */
export function audioContext(): AudioContext | null {
  if (context) {
    if (context.state === "suspended") void context.resume();
    return context;
  }
  const Context =
    typeof window !== "undefined"
      ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext)
      : undefined;
  if (!Context) return null;
  context = new Context();
  return context;
}

/** A reader returning the current loudness (0..1) of an audio node. */
export function levelMeter(node: AudioNode): () => number {
  const analyser = node.context.createAnalyser();
  analyser.fftSize = 1024;
  node.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const rms = Math.sqrt(sum / samples.length);
    // Speech RMS is usually 0.02–0.2; spread that over 0..1
    return Math.min(1, rms * 5);
  };
}
