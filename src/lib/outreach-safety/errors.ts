export class OutreachSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachSafetyError";
  }
}

export class DuplicateSendAuthorizationError extends OutreachSafetyError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super(
      `This exact outreach (prospect, draft, recipient, hash) has already been authorized and cannot be authorized again (${idempotencyKey}).`,
    );
    this.name = "DuplicateSendAuthorizationError";
    this.idempotencyKey = idempotencyKey;
  }
}