/** Erros de domínio/aplicação. A camada HTTP os traduz em status codes. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, readonly details?: unknown) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}
export class UnauthorizedError extends AppError {
  constructor(message = 'Credenciais inválidas') {
    super(message, 'UNAUTHORIZED', 401);
  }
}
export class ForbiddenError extends AppError {
  constructor(message = 'Sem permissão para esta ação') {
    super(message, 'FORBIDDEN', 403);
  }
}
export class NotFoundError extends AppError {
  constructor(message = 'Recurso não encontrado') {
    super(message, 'NOT_FOUND', 404);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}
