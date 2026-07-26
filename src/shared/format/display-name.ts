/** Full name if either part is set, otherwise the fallback (usually the email). */
export function displayNameFor(
  input: { firstName?: string | null; lastName?: string | null },
  fallback: string,
): string {
  const full = [input.firstName, input.lastName]
    .filter((v) => v !== null && v !== undefined && v.trim() !== '')
    .join(' ');
  return full !== '' ? full : fallback;
}
