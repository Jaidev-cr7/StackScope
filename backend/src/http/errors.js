// The error type the HTTP layer understands.
//
// Route handlers throw `ApiError` when they want a specific status and code;
// the app's error handler turns it into a JSON body. Anything else that
// escapes a handler is treated as a bug and reported as a generic 500.
export class ApiError extends Error {
  constructor(status, code, message, issues = null) {
    super(message || 'Request failed');
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
  }

  static badRequest(code, message, issues = null) {
    return new ApiError(400, code, message, issues);
  }

  static notFound(message = 'Not found.') {
    return new ApiError(404, 'not_found', message);
  }
}

export default ApiError;
