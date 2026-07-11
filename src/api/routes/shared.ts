export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export const isResourceNotFoundError = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }

  return /unknown account id|unknown mailbox|mailbox.*not found|no such mailbox/i.test(
    error.message
  );
};
