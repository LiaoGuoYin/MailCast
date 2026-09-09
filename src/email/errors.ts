export function errorProperty(error: unknown, key: string): unknown {
  return error && typeof error === 'object' ? Reflect.get(error, key) : undefined;
}

// The fallback is a parameter, not a constant: each caller persists its own
// wording — outbound failures, downstream results and the forward API payload
// are read in different places, and that text is part of what each one stores.
export function errorDescription(error: unknown, fallback: string): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string' ? error : fallback;
}
