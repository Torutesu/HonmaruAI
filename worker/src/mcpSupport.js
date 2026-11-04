export class McpInputError extends Error {}

export function requireMcpScope(actor, scope) {
  if (!actor.scopes?.includes(scope)) throw new McpInputError(`This connection requires the ${scope} permission.`);
}

export function mcpResult(value) {
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 190000) throw new McpInputError('Result is too large. Request a smaller page.');
  return { content: [{ type: 'text', text }], structuredContent: value };
}

export function mcpError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export function validateMcpInput(value, schema, path = 'arguments') {
  const fail = message => { throw new McpInputError(`${path} ${message}`); };
  if (schema.enum && !schema.enum.includes(value)) fail('has an unsupported value.');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object.');
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`requires ${key}.`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) validateMcpInput(item, schema.properties[key], `${path}.${key}`);
      else if (schema.additionalProperties === false) fail(`does not accept ${key}.`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) fail('must be an array.');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail('has too many items.');
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('has too few items.');
    if (schema.items) for (const item of value) validateMcpInput(item, schema.items, `${path}[]`);
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') fail('must be text.');
    if (schema.minLength !== undefined && value.length < schema.minLength) fail('is too short.');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) fail('is too long.');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('has an invalid format.');
  } else if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) fail('must be a valid number.');
    if (schema.minimum !== undefined && value < schema.minimum) fail('is below the minimum.');
    if (schema.maximum !== undefined && value > schema.maximum) fail('exceeds the maximum.');
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') fail('must be true or false.');
}
