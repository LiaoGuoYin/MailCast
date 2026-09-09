// D1 surfaces constraint violations only as a message string; there is no error
// code to match on, so the text is the contract we have.
export function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('unique constraint');
}
