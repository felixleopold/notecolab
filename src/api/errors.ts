export function requestErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('status' in error)) return undefined;
  return typeof error.status === 'number' ? error.status : undefined;
}

export function requestErrorMessage(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('json' in error)) return undefined;
  const json: unknown = error.json;
  if (typeof json !== 'object' || json === null || !('error' in json)) return undefined;
  return typeof json.error === 'string' ? json.error : undefined;
}
