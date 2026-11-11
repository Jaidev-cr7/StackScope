// Wrapping an async route handler.
//
// Express 4 does not catch a rejected promise from an async handler. The
// rejection escapes the route, becomes an unhandled rejection, and - since
// Node 15 - terminates the process.
//
// That turns any error inside an async handler into a remote denial of
// service: the request never gets a response and the server dies. The
// obvious example is a UNIQUE constraint violation on a duplicate email, but
// the rule is general and worth enforcing everywhere.
//
// Every async handler in this application is wrapped in this.
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export default asyncHandler;
