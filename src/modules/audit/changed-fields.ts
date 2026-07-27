/** Field names a PATCH supplied, for audit metadata. Names only, never values. */
export function changedFields(dto: object): string[] {
  return Object.entries(dto)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}
