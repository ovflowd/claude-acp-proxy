/**
 * Writes a problem to stderr, which the editor keeps in the agent's log. Stdout is the ACP connection, so
 * nothing but protocol messages may go there.
 *
 * @param {string} area The part of the proxy that hit the problem, such as `session config`.
 * @param {unknown} problem
 */
export function logProblem(area, problem) {
  const message = problem instanceof Error ? problem.message : String(problem);
  console.error(`claude-acp-proxy: ${area}: ${message}`);
}
