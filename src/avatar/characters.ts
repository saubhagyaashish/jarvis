// The selectable characters: VRoid sample models released under CC0
// (see public/avatars/LICENSE.md).

export const CHARACTERS = [
  { id: "vita", name: "Vita", model: "/avatars/vita.vrm" },
  { id: "shino", name: "Shino", model: "/avatars/shino.vrm" },
  { id: "vivi", name: "Vivi", model: "/avatars/vivi.vrm" },
  { id: "fumiriya", name: "Fumiriya", model: "/avatars/fumiriya.vrm" }
] as const;

export type CharacterId = (typeof CHARACTERS)[number]["id"];

export const DEFAULT_CHARACTER: CharacterId = "vita";

export function characterById(id: string | null | undefined) {
  return CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
}
