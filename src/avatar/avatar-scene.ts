// The 3D character: a VRM model rendered with three.js, kept alive with
// breathing, blinking and small head movements, with expressions for each
// mood and a mouth driven by the loudness of the reply audio.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";

export type AvatarMood =
  | "idle"
  | "happy"
  | "listening"
  | "thinking"
  | "speaking"
  | "sad";

type Expression = "happy" | "relaxed" | "sad" | "surprised" | "angry";

/** Target expression weights and head pose for each mood. */
const MOODS: Record<
  AvatarMood,
  {
    face: Partial<Record<Expression, number>>;
    tilt: number;
    nod: number;
    look: [number, number];
  }
> = {
  idle: { face: { relaxed: 0.25 }, tilt: 0, nod: 0, look: [0, 0] },
  happy: { face: { happy: 0.9 }, tilt: 0.08, nod: -0.04, look: [0, 0] },
  listening: { face: { relaxed: 0.4 }, tilt: -0.1, nod: 0.03, look: [0, 0] },
  thinking: { face: {}, tilt: 0.12, nod: -0.08, look: [0.35, 0.3] },
  speaking: { face: { relaxed: 0.3 }, tilt: 0, nod: 0, look: [0, 0] },
  sad: { face: { sad: 0.7 }, tilt: 0.06, nod: 0.08, look: [0, -0.15] }
};

const FACE: Expression[] = ["happy", "relaxed", "sad", "surprised", "angry"];
const MOUTH = ["aa", "ih", "ou", "ee", "oh"] as const;
const WAVE_SECONDS = 2.4;
// Normalized-bone z rotations with the arms resting at the sides. In this
// space (VRM 0.x, turned to face the camera) +z lowers the left arm.
const ARM_DOWN = 1.2;
const ELBOW_REST = 0.15;

export class AvatarScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(28, 1, 0.1, 20);
  private clock = new THREE.Clock();
  private lookTarget = new THREE.Object3D();
  private vrm: VRM | null = null;
  private frame = 0;
  private time = 0;
  private mood: AvatarMood = "idle";
  private weights = new Map<string, number>();
  private nextBlinkAt = 2;
  private blinkStartedAt = -1;
  private waveStartedAt = -1;
  private headY = 1.35;
  private tilt = 0;
  private nod = 0;
  private look = new THREE.Vector2();

  constructor(
    canvas: HTMLCanvasElement,
    /** Polled every frame: how loud the reply is (0..1), for the mouth. */
    private speechLevel: () => number
  ) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    const key = new THREE.DirectionalLight(0xffffff, Math.PI * 0.6);
    key.position.set(1, 1.5, 2);
    const rim = new THREE.DirectionalLight(0x8ab4ff, Math.PI * 0.35);
    rim.position.set(-1.5, 1, -1);
    this.scene.add(key, rim, new THREE.AmbientLight(0xffffff, 0.35));
    this.scene.add(this.lookTarget);
  }

  async load(url: string, onProgress: (fraction: number) => void) {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url, (e) => {
      if (e.total) onProgress(e.loaded / e.total);
    });
    const vrm = gltf.userData.vrm as VRM;
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x models face away from the camera
    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
    });
    this.scene.add(vrm.scene);
    this.vrm = vrm;

    // Frame the head and shoulders, whatever the model's height
    vrm.scene.updateMatrixWorld(true);
    const head = vrm.humanoid.getNormalizedBoneNode("head");
    if (head) this.headY = head.getWorldPosition(new THREE.Vector3()).y;
    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;
    this.restPose();
    // Let the hair and clothes physics start from the resting pose, not the
    // T-pose the model loaded in (otherwise the hair flies outwards)
    vrm.humanoid.update();
    vrm.springBoneManager?.setInitState();
    vrm.springBoneManager?.reset();
    this.frameCamera();
    this.clock.start();
    this.loop();
  }

  setMood(mood: AvatarMood) {
    this.mood = mood;
  }

  /** A short wave with the right hand (used for the greeting). */
  wave() {
    this.waveStartedAt = this.time;
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.frameCamera();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.renderer.dispose();
  }

  private frameCamera() {
    // Narrow screens (phones) step back a little to keep the shoulders in
    // The head bone sits at the base of the skull; the face is just above
    const distance = this.camera.aspect < 0.8 ? 1.5 : 1.2;
    this.camera.position.set(0, this.headY + 0.06, distance);
    this.camera.lookAt(0, this.headY - 0.02, 0);
    this.camera.updateProjectionMatrix();
  }

  /** Arms down from the T-pose the model loads in. */
  private restPose() {
    const bone = (
      name: Parameters<VRM["humanoid"]["getNormalizedBoneNode"]>[0]
    ) => this.vrm?.humanoid.getNormalizedBoneNode(name);
    const leftUpper = bone("leftUpperArm");
    const rightUpper = bone("rightUpperArm");
    const leftLower = bone("leftLowerArm");
    const rightLower = bone("rightLowerArm");
    if (leftUpper) leftUpper.rotation.set(0, 0, ARM_DOWN);
    if (rightUpper) rightUpper.rotation.set(0, 0, -ARM_DOWN);
    if (leftLower) leftLower.rotation.set(0, 0, ELBOW_REST);
    if (rightLower) rightLower.rotation.set(0, 0, -ELBOW_REST);
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const vrm = this.vrm;
    if (!vrm) return;
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;
    const t = this.time;
    const target = MOODS[this.mood];
    const ease = 1 - Math.exp(-dt * 6); // smooth, frame-rate independent

    // Head pose: mood tilt/nod plus a gentle idle sway
    this.tilt += (target.tilt - this.tilt) * ease;
    this.nod += (target.nod - this.nod) * ease;
    const bone = (
      name: Parameters<VRM["humanoid"]["getNormalizedBoneNode"]>[0]
    ) => vrm.humanoid.getNormalizedBoneNode(name);
    const head = bone("head");
    const neck = bone("neck");
    const chest = bone("chest") ?? bone("spine");
    if (head) {
      head.rotation.z = this.tilt + Math.sin(t * 0.7) * 0.02;
      head.rotation.x = this.nod + Math.sin(t * 0.5) * 0.015;
      head.rotation.y = Math.sin(t * 0.4) * 0.04;
    }
    if (neck) neck.rotation.y = Math.sin(t * 0.3) * 0.02;
    if (chest) chest.rotation.x = Math.sin(t * 1.6) * 0.012; // breathing

    // Eyes follow the camera, glancing up and aside when thinking
    this.look.x += (target.look[0] - this.look.x) * ease;
    this.look.y += (target.look[1] - this.look.y) * ease;
    this.lookTarget.position.set(
      this.camera.position.x + this.look.x + Math.sin(t * 0.9) * 0.02,
      this.camera.position.y + this.look.y,
      this.camera.position.z
    );

    this.updateWave(t);

    // Expressions ease toward the mood's targets
    const em = vrm.expressionManager;
    if (em) {
      for (const name of FACE) {
        this.ease(em, name, target.face[name] ?? 0, ease);
      }
      // Mouth: loudness opens it; the shape drifts between vowels
      const level = this.mood === "speaking" ? this.speechLevel() : 0;
      const open = Math.min(1, level * 1.3);
      const vowel = (Math.sin(t * 7.3) + 1) / 2;
      const mouth: Record<(typeof MOUTH)[number], number> = {
        aa: open * (0.6 + 0.4 * (1 - vowel)),
        oh: open * 0.5 * vowel,
        ee: open * 0.3 * ((Math.cos(t * 5.1) + 1) / 2),
        ih: 0,
        ou: 0
      };
      for (const name of MOUTH) this.ease(em, name, mouth[name], 0.6);
      // Blink every few seconds (not while smiling with eyes closed)
      em.setValue(
        "blink",
        this.blink(t) * (1 - (this.weights.get("happy") ?? 0))
      );
    }

    vrm.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  private ease(
    em: NonNullable<VRM["expressionManager"]>,
    name: string,
    target: number,
    amount: number
  ) {
    const current = this.weights.get(name) ?? 0;
    const next = current + (target - current) * amount;
    this.weights.set(name, next);
    em.setValue(name, next);
  }

  /** 0..1 eyelid closure; a quick blink every 2–6 seconds. */
  private blink(t: number): number {
    if (this.blinkStartedAt < 0 && t >= this.nextBlinkAt) {
      this.blinkStartedAt = t;
    }
    if (this.blinkStartedAt < 0) return 0;
    const phase = (t - this.blinkStartedAt) / 0.16;
    if (phase >= 1) {
      this.blinkStartedAt = -1;
      this.nextBlinkAt = t + 2 + Math.random() * 4;
      return 0;
    }
    return Math.sin(phase * Math.PI);
  }

  private updateWave(t: number) {
    const vrm = this.vrm;
    if (!vrm) return;
    const upper = vrm.humanoid.getNormalizedBoneNode("rightUpperArm");
    const lower = vrm.humanoid.getNormalizedBoneNode("rightLowerArm");
    if (!upper || !lower) return;
    const elapsed = this.waveStartedAt < 0 ? -1 : t - this.waveStartedAt;
    if (elapsed < 0 || elapsed > WAVE_SECONDS) {
      this.waveStartedAt = -1;
      upper.rotation.set(0, 0, -ARM_DOWN);
      lower.rotation.set(0, 0, -ELBOW_REST);
      return;
    }
    // Raise (0–0.4 s), wave, lower (last 0.4 s)
    const raise = Math.min(1, elapsed / 0.4, (WAVE_SECONDS - elapsed) / 0.4);
    const smooth = raise * raise * (3 - 2 * raise);
    // Upper arm out to the side, forearm up, hand swinging
    upper.rotation.set(0, 0, -ARM_DOWN + (ARM_DOWN + 0.05) * smooth);
    lower.rotation.set(
      0,
      0,
      -ELBOW_REST + (ELBOW_REST + 1.3 + Math.sin(elapsed * 10) * 0.3) * smooth
    );
  }
}
