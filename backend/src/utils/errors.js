/**
 * Error class carrying an HTTP status code and a machine-readable code,
 * so route handlers can `throw` and the central error handler will turn
 * it into a clean JSON response.
 */
export class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

export const badRequest = (code, msg, details) => new HttpError(400, code, msg, details);
export const unauthorized = (code, msg) => new HttpError(401, code, msg);
export const forbidden = (code, msg) => new HttpError(403, code, msg);
export const notFound = (code, msg) => new HttpError(404, code, msg);
export const conflict = (code, msg) => new HttpError(409, code, msg);
