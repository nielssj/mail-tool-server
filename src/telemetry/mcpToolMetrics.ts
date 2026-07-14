import * as telemetry from './instruments.js';

/**
 * A tool handler's resolved result carries `isError: true` plus a
 * `structuredContent.error.code` when mcp/errors.ts's withToolErrors caught
 * something — duck-typed here rather than importing ToolErrorResult, so
 * this module stays decoupled from errors.ts's specific shape.
 */
const extractOutcome = (result: unknown): string => {
  if (typeof result !== 'object' || result === null) {
    return 'ok';
  }
  if ((result as { isError?: unknown }).isError !== true) {
    return 'ok';
  }
  const code = (result as { structuredContent?: { error?: { code?: unknown } } }).structuredContent
    ?.error?.code;
  return typeof code === 'string' ? code : 'error';
};

/**
 * Decorates a tool handler (already wrapped by mcp/errors.ts's
 * withToolErrors) to record mailtool.mcp.tool.duration, tagged by tool
 * name and outcome. Applied at each tool's registerTool call site — MCP
 * tools are registered individually rather than through one shared
 * interface object, so unlike mailboxService there's no single point to
 * wrap all of them at once.
 */
export const withToolMetrics = <Args extends unknown[], R>(
  tool: string,
  handler: (...args: Args) => Promise<R>
) => {
  return async (...args: Args): Promise<R> => {
    const start = performance.now();
    const result = await handler(...args);
    telemetry.mcpToolDuration.record((performance.now() - start) / 1000, {
      tool,
      outcome: extractOutcome(result)
    });
    return result;
  };
};
