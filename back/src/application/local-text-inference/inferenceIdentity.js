/** Database JSON key order cannot change an immutable provider identity. */
export function canonicalInferenceJson(value) {
  if (Array.isArray(value)) return value.map(canonicalInferenceJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalInferenceJson(value[key])]));
  return value;
}
export const inferenceProfileKey = (profile) => JSON.stringify(canonicalInferenceJson(profile ?? null));
