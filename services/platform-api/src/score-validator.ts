const DIMENSIONS = ['verify', 'spec', 'code', 'collab'] as const;
type DimensionName = typeof DIMENSIONS[number];

export interface ScoreCheck {
  total: number;
  recalculatedTotal: number;
  errors: string[];
}

/** Recompute score from criteria and reject client/model arithmetic. */
export function checkEvaluationScore(result: Record<string, any>): ScoreCheck {
  const sums: Record<string, number> = {};
  const maxes: Record<string, number> = {};
  const keys = new Set<string>();
  const errors: string[] = [];
  for (const criterion of Array.isArray(result.criteria) ? result.criteria : []) {
    const key = String(criterion.key ?? '');
    const dim = String(criterion.dim ?? '');
    if (keys.has(key)) errors.push(`duplicate criterion key: ${key}`);
    keys.add(key);
    const score = Number(criterion.score);
    const max = Number(criterion.max);
    if (!Number.isFinite(score) || !Number.isFinite(max) || score < 0 || score > max) {
      errors.push(`criterion score out of range: ${key}`);
      continue;
    }
    sums[dim] = (sums[dim] ?? 0) + score;
    maxes[dim] = (maxes[dim] ?? 0) + max;
  }
  let recalculatedTotal = 0;
  for (const dim of DIMENSIONS) {
    const dimension = result.dimensions?.[dim];
    if (!dimension) {
      errors.push(`missing dimension: ${dim}`);
      continue;
    }
    const evaluated = Boolean(dimension.evaluated);
    const score = dimension.score === null ? null : Number(dimension.score);
    if (!evaluated) {
      if (score !== null) errors.push(`unevaluated dimension must have null score: ${dim}`);
      if (sums[dim] !== undefined || maxes[dim] !== undefined) errors.push(`criteria exist for unevaluated dimension: ${dim}`);
      continue;
    }
    if (score === null || !Number.isFinite(score)) {
      errors.push(`evaluated dimension has null score: ${dim}`);
      continue;
    }
    const expected = sums[dim] ?? 0;
    if (Math.abs(score - expected) > 0.0001) errors.push(`dimension mismatch: ${dim} expected ${expected}, got ${score}`);
    const declaredMax = Number(dimension.max);
    if (maxes[dim] !== undefined && Math.abs(declaredMax - maxes[dim]) > 0.0001) errors.push(`dimension max mismatch: ${dim}`);
    recalculatedTotal += score;
  }
  const declaredTotal = Number(result.total);
  if (!Number.isFinite(declaredTotal) || Math.abs(declaredTotal - recalculatedTotal) > 0.0001) {
    errors.push(`total mismatch: expected ${recalculatedTotal}, got ${result.total}`);
  }
  return { total: declaredTotal, recalculatedTotal: Number(recalculatedTotal.toFixed(4)), errors };
}
