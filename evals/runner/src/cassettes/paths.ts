// Repo paths used by the recorder, the replay comparator, and their tests.
import { fileURLToPath } from "node:url";

const from = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export const EVALS_DIR = from("../../../");
export const GOLDEN_DIR = from("../../../golden");
export const CASSETTE_DIR = from("../../../cassettes");
export const BASELINE_DIR = from("../../../baseline");
export const REPLAY_BASELINE_PATH = from("../../../baseline/replay.json");
