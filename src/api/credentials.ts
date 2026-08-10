export function requestHeaders(apiKey: string, includeCredentials: boolean): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(includeCredentials && apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export function websocketCredentials(
  apiKey: string,
  includeCredentials: boolean,
): Record<string, string> {
  return includeCredentials && apiKey ? { token: apiKey } : {};
}
