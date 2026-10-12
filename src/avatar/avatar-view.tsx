import { useEffect, useRef, useState } from "react";
import type { AvatarMood, AvatarScene } from "./avatar-scene";

export type { AvatarMood };

type Props = {
  /** URL of the VRM model, e.g. /avatars/shino.vrm */
  model: string;
  mood: AvatarMood;
  /** Changes to this number make the character wave. */
  waveKey?: number;
  /** How loud the reply is right now (0..1), polled every frame. */
  speechLevel: () => number;
};

/**
 * The 3D character. three.js and the model load only when this mounts, so
 * the chat-only screen stays light.
 */
export function AvatarView({ model, mood, waveKey, speechLevel }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<AvatarScene | null>(null);
  const levelRef = useRef(speechLevel);
  levelRef.current = speechLevel;
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const waveRef = useRef(waveKey);
  waveRef.current = waveKey;
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">(
    "loading"
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    let disposed = false;
    let scene: AvatarScene | null = null;
    let observer: ResizeObserver | null = null;

    setStatus("loading");
    setProgress(0);
    import("./avatar-scene")
      .then(async ({ AvatarScene }) => {
        if (disposed) return;
        scene = new AvatarScene(canvas, () => levelRef.current());
        sceneRef.current = scene;
        const resize = () =>
          scene?.resize(container.clientWidth, container.clientHeight);
        observer = new ResizeObserver(resize);
        observer.observe(container);
        resize();
        await scene.load(model, (fraction) => {
          if (!disposed) setProgress(fraction);
        });
        if (disposed) return;
        scene.setMood(moodRef.current);
        // A wave asked for while the model was loading (e.g. the greeting)
        if (waveRef.current) scene.wave();
        setStatus("ready");
      })
      .catch((error: unknown) => {
        console.error("Avatar failed to load:", error);
        if (!disposed) setStatus("failed");
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [model]);

  useEffect(() => {
    sceneRef.current?.setMood(mood);
  }, [mood]);

  useEffect(() => {
    if (waveKey) sceneRef.current?.wave();
  }, [waveKey]);

  return (
    <div ref={containerRef} className="relative h-full w-full">
      <canvas ref={canvasRef} className="block h-full w-full" />
      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm text-white/70">
            {status === "failed"
              ? "Couldn't load the character."
              : `Waking up… ${Math.round(progress * 100)}%`}
          </span>
        </div>
      )}
    </div>
  );
}
