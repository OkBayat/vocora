// This interpreter supports only the closed schema vocabulary above. Unknown
// keywords fail closed so future schema extensions must update this owner too.
export function matchesClosedSchema(schema, value) {
  const keywords = new Set(['type', 'const', 'enum', 'anyOf', 'properties', 'required',
    'additionalProperties', 'minLength', 'maxLength', 'minItems', 'maxItems',
    'uniqueItems', 'items', 'minimum', 'maximum']);
  if (Object.keys(schema).some(key => !keywords.has(key))) return false;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.anyOf && !schema.anyOf.some(candidate => matchesClosedSchema(candidate, value))) return false;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'null') return value === null;
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    const chars = Array.from(value);
    if (chars.some(char => char.codePointAt(0) >= 0xd800 && char.codePointAt(0) <= 0xdfff)) return false;
    return chars.length >= schema.minLength && chars.length <= schema.maxLength
      && (schema.minLength === 0 || value.trim().length > 0);
  }
  if (schema.type === 'array') return Array.isArray(value)
    && value.length >= (schema.minItems ?? 0) && value.length <= schema.maxItems
    && (!schema.uniqueItems || new Set(value.map(item => JSON.stringify(item))).size === value.length)
    && value.every(item => matchesClosedSchema(schema.items, item));
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
    && schema.required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => Object.hasOwn(schema.properties, key))
    && Object.entries(schema.properties).every(([key, child]) => matchesClosedSchema(child, value[key]));
  return schema.type === undefined;
}
