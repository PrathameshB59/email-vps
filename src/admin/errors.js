class AdminAuthError extends Error {
  constructor(message, code = "ADMIN_AUTH_ERROR", statusCode = 401) {
    super(message);
    this.name = "AdminAuthError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

class AdminValidationError extends Error {
  constructor(message, code = "ADMIN_VALIDATION_ERROR", statusCode = 400) {
    super(message);
    this.name = "AdminValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

module.exports = {
  AdminAuthError,
  AdminValidationError,
};
