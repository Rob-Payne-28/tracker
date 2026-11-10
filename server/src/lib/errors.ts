export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public possibleFix?: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, fix?: string) => new ApiError(400, 'invalid_parameter', msg, fix);
export const unauthenticated = (msg = 'Authentication required.') =>
  new ApiError(401, 'unauthenticated', msg, 'Supply a valid X-TrackerToken header (your API token) or sign in.');
export const forbidden = (msg = 'You do not have permission to perform this action.') =>
  new ApiError(403, 'unauthorized_operation', msg);
export const notFound = (what = 'Resource') => new ApiError(404, 'unfound_resource', `${what} not found.`);
export const conflict = (msg: string) => new ApiError(409, 'conflict', msg);
