/**
 * Bridge to vodou-ax Swift binary.
 * Spawns the binary as a subprocess, passes CLI args, parses JSON output.
 */
import type { VodouAxResponse } from './types.js';
/**
 * Call vodou-ax with a subcommand and arguments.
 * Returns parsed JSON response. Throws on errors.
 */
export declare function callVodouAx(subcommand: string, args?: Record<string, unknown>): Promise<VodouAxResponse>;
//# sourceMappingURL=ax-bridge.d.ts.map