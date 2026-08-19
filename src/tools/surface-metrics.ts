/**
 * Arithmetic over the tool surface a client receives on `tools/list`.
 *
 * Every byte counted here sits in the cached prefix of every single request a
 * client makes, so the surface is not paid once per session but once per call.
 * That makes it worth measuring continuously rather than estimating: a field
 * description added without thought is a permanent per-call tax, and the only
 * way to notice is to have the number in front of you.
 *
 * The split between prose and structure matters because they shrink by
 * different means. Prose shrinks by rewriting, and how far it can shrink is
 * bounded by what a caller still needs to get the call right. Structure shrinks
 * only by having fewer, less duplicated tools, since JSON Schema `$ref` is
 * document-local and cannot be shared across tools.
 */

/** One entry of a `tools/list` result, narrowed to the parts that cost bytes. */
export interface SurfaceTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface SurfaceMetrics {
  /** Tool descriptions plus serialised input schemas: the whole cost. */
  total: number;
  /** The tool-level `description` strings. */
  toolDescriptions: number;
  /** Every `description` string nested anywhere inside an input schema. */
  fieldProse: number;
  /** What is left of the schemas once their prose is subtracted. */
  structure: number;
  /** Per-tool total, so the expensive tools are obvious without a diff. */
  perTool: Record<string, number>;
}

/**
 * Total the length of every `description` string anywhere in a JSON Schema.
 *
 * Keyed on the JSON Schema keyword, not on a field happening to be named
 * `description`: a request field called `description` appears as
 * `properties.description`, whose value is an object rather than a string, so
 * it is walked rather than counted.
 */
function sumDescriptions(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce((carried: number, item) => carried + sumDescriptions(item), 0);
  }
  if (node === null || typeof node !== 'object') {
    return 0;
  }
  let total = 0;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      total += value.length;
    } else {
      total += sumDescriptions(value);
    }
  }
  return total;
}

export function surfaceMetrics(tools: readonly SurfaceTool[]): SurfaceMetrics {
  const metrics: SurfaceMetrics = {
    total: 0,
    toolDescriptions: 0,
    fieldProse: 0,
    structure: 0,
    perTool: {},
  };

  for (const tool of tools) {
    const described = tool.description?.length ?? 0;
    const serialised = JSON.stringify(tool.inputSchema ?? {}).length;
    const prose = sumDescriptions(tool.inputSchema);

    metrics.toolDescriptions += described;
    metrics.fieldProse += prose;
    metrics.structure += serialised - prose;
    metrics.total += described + serialised;
    metrics.perTool[tool.name] = described + serialised;
  }

  return metrics;
}
