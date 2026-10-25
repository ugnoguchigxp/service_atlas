// Safety enforcement for standard credential fields, not semantic classification.
// Public-only benchmark input remains required; this is not a general PII detector.
const secretKey = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|access_token|refresh_token|id_token|api[_-]?key|token)$/i;
export function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:ub_live_|ubr_)[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|password|secret)=)[^&#\s"']*/gi, '$1[REDACTED]')
    .replace(/(^|\n)(\s*(?:authorization|cookie|set-cookie|password|access_token|refresh_token|api[_-]?key)\s*:\s*)[^\n]*/gi, '$1$2[REDACTED]');
}
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    // HAR/header arrays encode a secret field as {name, value}.
    if (typeof object.name === 'string' && secretKey.test(object.name) && 'value' in object)
      return {...object, value: '[REDACTED]'};
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, secretKey.test(key) ? '[REDACTED]' : redact(entry)]));
  }
  return value;
}
export function serializedEvidence(value: unknown): string {
  return typeof value === 'string' ? redactText(value) : JSON.stringify(redact(value), null, 2);
}
