// The strict, opt-in data contract shares its rules with write validation.
export function valuesSchema(columns) {
  return { type: 'object', additionalProperties: false, properties: Object.fromEntries(columns.map(c => {
    let schema = { type: ['string', 'null'], maxLength: 5000 };
    if (c.type === 'number') schema = { type: ['number', 'null'] };
    if (c.type === 'checkbox') schema = { type: ['boolean', 'null'] };
    if (c.type === 'date') schema = { type: ['string', 'null'], format: 'date' };
    if (c.type === 'email') schema = { type: ['string', 'null'], format: 'email', maxLength: 320 };
    if (c.type === 'url') schema = { type: ['string', 'null'], format: 'uri', pattern: '^https?://', maxLength: 2000 };
    if (c.type === 'person') schema = { type: ['string', 'null'], minLength: 1, maxLength: 64 };
    if (c.type === 'select') schema = { type: ['string', 'null'], enum: [...(c.options || []), null] };
    if (c.type === 'relation') schema = c.multiple
      ? { type: ['array', 'null'], maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 64 }, description: `Record IDs from app entity ${c.targetEntity}.` }
      : { type: ['string', 'null'], minLength: 1, maxLength: 64, description: `Record ID from app entity ${c.targetEntity}.` };
    return [c.id, { title: c.name, ...schema }];
  })) };
}

export function validateValues(columns, values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return [{ field: 'values', message: 'Expected an object.' }];
  const schema = valuesSchema(columns);
  const errors = [];
  for (const [key, value] of Object.entries(values)) {
    const rule = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    let valid = !!rule;
    if (rule && value !== null) {
      valid = rule.type.includes(Array.isArray(value) ? 'array' : typeof value);
      if (typeof value === 'number') valid &&= Number.isFinite(value);
      if (Array.isArray(value)) valid &&= value.length <= (rule.maxItems ?? Infinity) && (!rule.uniqueItems || new Set(value).size === value.length) && value.every(item => typeof item === 'string' && item.length >= (rule.items?.minLength ?? 0) && item.length <= (rule.items?.maxLength ?? Infinity));
      if (typeof value === 'string') {
        valid &&= value.length <= (rule.maxLength ?? Infinity) && value.length >= (rule.minLength ?? 0);
        if (rule.format === 'date') {
          const d = new Date(value);
          valid &&= /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
        }
        if (rule.format === 'email') valid &&= /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        if (rule.format === 'uri') {
          try { valid &&= /^https?:\/\//.test(value) && !!new URL(value).hostname; } catch { valid = false; }
        }
      }
      if (rule.enum) valid &&= rule.enum.includes(value);
    }
    if (!valid) errors.push({ field: key, message: rule ? 'Value does not match the column contract.' : 'Unknown column id.' });
  }
  return errors;
}

export function tableContract(table) {
  const values = valuesSchema(table.columns);
  const path = `/tables/${table.id}`;
  const response = description => ({ description });
  const orgQuery = { name: 'orgId', in: 'query', required: true, schema: { type: 'string', const: table.orgId } };
  const rowParam = { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } };
  const requestBody = update => ({ required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['orgId', 'values', 'validation', ...(update ? ['expectedUpdatedAt'] : [])],
    properties: { orgId: { type: 'string', const: table.orgId }, validation: { const: 'strict' }, values,
      ...(update ? { expectedUpdatedAt: { type: 'string', description: 'Exact updatedAt returned by the last read.' } } : {}) },
  } } } });
  return {
    openapi: '3.1.0', info: { title: `${table.name} record API`, version: '1.0.0', description: 'Strict opt-in contract. Legacy requests without validation=strict continue to coerce values. All operations require current table access. PATCH merges supplied fields; null clears a value.' },
    security: [{ session: [] }], components: { securitySchemes: { session: { type: 'apiKey', in: 'header', name: 'x-session-token' } }, schemas: { Values: values } },
    paths: {
      [path]: { get: { parameters: [orgQuery, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5000, default: 500 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 5000, default: 0 } }], responses: { 200: response('Table, rows, total and nextOffset (null at the end). Offsets reflect current data, not a frozen snapshot. Rows include updatedAt for optimistic edits.'), 404: response('Unavailable table.') } } },
      [`${path}/rows`]: { post: { requestBody: requestBody(false), responses: { 201: response('Created row.'), 400: response('Invalid values; no write.'), 404: response('Unavailable table.') } } },
      [`${path}/rows/{rowId}`]: {
        patch: { parameters: [rowParam], requestBody: requestBody(true), responses: { 200: response('Updated row.'), 400: response('Invalid values; no write.'), 404: response('Unavailable record.'), 409: response('Row changed; reload before retrying.') } },
        delete: { parameters: [rowParam, orgQuery, { name: 'expectedUpdatedAt', in: 'query', required: true, schema: { type: 'string' } }], responses: { 200: response('Deleted.'), 404: response('Unavailable record.'), 409: response('Row changed; not deleted.') } },
      },
    },
  };
}
