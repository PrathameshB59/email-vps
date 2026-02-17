class MailValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailValidationError";
    this.code = "VALIDATION_ERROR";
    this.statusCode = 400;
  }
}

class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuotaExceededError";
    this.code = "DAILY_QUOTA_EXCEEDED";
    this.statusCode = 429;
  }
}

module.exports = {
  MailValidationError,
  QuotaExceededError,
};
