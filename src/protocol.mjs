/**
 * A JSON-RPC message on the ACP connection. The fields stay loose: anything can arrive on the wire, so code that
 * takes one still checks what it reads.
 *
 * @typedef {object} Message
 * @property {string} [jsonrpc]
 * @property {string | number} [id]
 * @property {string} [method]
 * @property {any} [params]
 * @property {any} [result]
 * @property {any} [error]
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {string} line
 * @returns {unknown} Undefined when the line is not JSON.
 */
export function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
