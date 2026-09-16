export const MAX_USERNAME_LENGTH = 40;

export function normalizeUsername(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const username = value.trim();
  if (username.length < 2 || username.length > MAX_USERNAME_LENGTH || /[\u0000-\u001f\u007f]/.test(username)) {
    return undefined;
  }
  return username;
}
