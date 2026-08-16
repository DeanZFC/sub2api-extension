export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(code, message, details) {
  return new AppError(400, code, message, details);
}

export function unauthorized(message = '未登录或会话已过期') {
  return new AppError(401, 'UNAUTHORIZED', message);
}

export function forbidden(message = '无权执行此操作') {
  return new AppError(403, 'FORBIDDEN', message);
}

export function notFound(resource = '资源') {
  return new AppError(404, 'NOT_FOUND', `${resource}不存在`);
}

export function conflict(code, message) {
  return new AppError(409, code, message);
}

export function asAppError(error) {
  if (error instanceof AppError) return error;
  return new AppError(500, 'INTERNAL_ERROR', '服务器内部错误');
}
