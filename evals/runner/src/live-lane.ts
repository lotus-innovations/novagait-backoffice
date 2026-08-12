// Live-lane request configuration for the LOT-105 model matrix (LOT-119).
//
// The mock/replay lane never reaches this module: it makes no API calls at
// all, so nothing here can affect cassettes or the CI replay gate. This is
// the config a live matrix run passes to runWorkflow.
//
// Two decisions are encoded here, both Abhinav-approved 2026-08-11:
//
//   1. Thinking is DISABLED for matrix runs. The matrix grades routing and
//      extraction against a fixed golden set, not open-ended reasoning, and
//      adaptive thinking on sonnet-5/opus-5 adds output tokens (and variance)
//      to a comparison whose whole point is to be comparable across models.
//      The production Haiku path is untouched: haiku-4-5 predates the
//      parameter, so resolveThinking() in the agent loop drops it rather than
//      sending a param the model would reject. The guard is the agent's, not
//      this module's - a caller cannot route around it by editing this file.
//
//   2. The cache TTL is 1h, not the interactive 5m. A matrix sweep runs 73
//      cases x 3 models with judge passes interleaved, so the gap between two
//      reads of the same prefix can exceed five minutes; the docs recommend
//      the 1h TTL for batch work. The 2x write premium is paid once per model
//      and repaid on the second case.

import type Anthropic from "@anthropic-ai/sdk";
import { CACHE_TTL_BATCH, type CacheTtl } from "@novagait/agent";

export const LIVE_MATRIX_MODELS = [
  "claude-haiku-4-5",
  "claude-sonnet-5",
  "claude-opus-5",
] as const;
export type LiveMatrixModel = (typeof LIVE_MATRIX_MODELS)[number];

export const MATRIX_THINKING: Anthropic.Beta.BetaThinkingConfigParam = {
  type: "disabled",
};

export interface LiveLaneConfig {
  model: LiveMatrixModel;
  cacheTtl: CacheTtl;
  thinking: Anthropic.Beta.BetaThinkingConfigParam;
}

/**
 * The request config for one model in the matrix.
 *
 * `thinking` is always the disabled config; the agent loop's allowlist is
 * what decides whether it actually goes on the wire, so this stays a single
 * uniform config and the model-capability question lives in exactly one
 * place (packages/agent/src/loop.ts, THINKING_CONFIG_SUPPORTED).
 */
export function liveLaneConfig(model: LiveMatrixModel): LiveLaneConfig {
  return { model, cacheTtl: CACHE_TTL_BATCH, thinking: MATRIX_THINKING };
}
