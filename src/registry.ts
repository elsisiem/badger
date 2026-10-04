import type { Mastra } from "@mastra/core/mastra";

/** Lets the engine reach the Mastra instance without importing it (mastra.ts imports the agents, which import the engine). */
let ref: Mastra | null = null;
export const setMastra = (m: Mastra) => {
  ref = m;
};
export const getMastra = (): Mastra => {
  if (!ref) throw new Error("Mastra is not initialised yet");
  return ref;
};
