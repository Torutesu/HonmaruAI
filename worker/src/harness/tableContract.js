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
  const jsonResponse = (description, schema) => ({ description, content: { 'application/json': { schema } } });
  const ref = name => ({ $ref: `#/components/schemas/${name}` });
  const orgQuery = { name: 'orgId', in: 'query', required: true, schema: { type: 'string', const: table.orgId } };
  const rowParam = { name: 'rowId', in: 'path', required: true, schema: { type: 'string' } };
  const rowSchema = ref('Row');
  const pageSchema = ref('RowPage');
  const rowResult = { type: 'object', required: ['row'], properties: { row: rowSchema } };
  const filters = Object.fromEntries(table.columns.map(column => [column.id, values.properties[column.id]]));
  const requestBody = update => ({ required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['orgId', 'values', 'validation', ...(update ? ['expectedUpdatedAt'] : [])],
    properties: { orgId: { type: 'string', const: table.orgId }, validation: { type: 'string', const: 'strict' }, values,
      ...(update ? { expectedUpdatedAt: { type: 'string', format: 'date-time', description: 'Exact updatedAt returned by the last read.' } } : {}) },
  } } } });
  return {
    openapi: '3.1.0', info: { title: `${table.name} record API`, version: '1.0.0', description: 'Strict opt-in contract. Legacy requests without validation=strict continue to coerce values. All operations require current table access. PATCH merges supplied fields; null clears a value.' },
    security: [{ session: [] }], components: { securitySchemes: { session: { type: 'apiKey', in: 'header', name: 'x-session-token' } }, schemas: {
      Values: values,
      Row: { type: 'object', required: ['id', 'tableId', 'values', 'position', 'createdBy', 'updatedBy', 'createdAt', 'updatedAt'], properties: {
        id: { type: 'string' }, tableId: { type: 'string', const: table.id }, values: ref('Values'), position: { type: 'integer' },
        createdBy: { type: ['string', 'null'] }, updatedBy: { type: ['string', 'null'] },
        createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
      } },
      RowPage: { type: 'object', required: ['table', 'rows', 'total', 'offset', 'limit', 'nextOffset'], properties: {
        table: { type: 'object', required: ['id', 'orgId', 'name', 'columns', 'createdBy', 'createdAt', 'updatedAt'], properties: {
          id: { type: 'string', const: table.id }, orgId: { type: 'string', const: table.orgId }, name: { type: 'string' },
          columns: { type: 'array', items: { type: 'object', required: ['id', 'name', 'type'], properties: {
            id: { type: 'string' }, name: { type: 'string' }, type: { type: 'string', enum: ['text', 'number', 'date', 'select', 'checkbox', 'url', 'person', 'email', 'relation'] },
            options: { type: 'array', items: { type: 'string' } }, targetEntity: { type: 'string' }, multiple: { type: 'boolean' },
          } } },
          createdBy: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
        } },
        rows: { type: 'array', items: rowSchema }, total: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 5000 }, nextOffset: { type: ['integer', 'null'], minimum: 0 },
      } },
      RowResult: rowResult,
      DeleteResult: { type: 'object', required: ['deleted', 'before'], properties: { deleted: { const: true }, before: rowSchema } },
      Error: { type: 'object', required: ['message'], properties: { message: { type: 'string' }, fields: { type: 'array', items: { type: 'object', required: ['field', 'message'], properties: { field: { type: 'string' }, message: { type: 'string' } } } } } },
    } },
    paths: {
      [path]: { get: { operationId: 'listTableRows', summary: `List rows in ${table.name}`, parameters: [orgQuery,
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 5000, default: 500 } },
        { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 5000, default: 0 } },
        { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Case-insensitive substring search across every column.' },
        { name: 'sort', in: 'query', schema: { type: 'string', enum: table.columns.flatMap(column => [column.id, `-${column.id}`]) }, description: 'Sort by a column ID; prefix with - for descending order. Null values remain last.' },
        { name: 'where', in: 'query', description: 'JSON-encoded equality filters. Keys may be column IDs or names; every supplied condition must match.', content: { 'application/json': { schema: { type: 'object', additionalProperties: false, properties: filters } } } },
      ], responses: { 200: jsonResponse('Table, filtered rows, total and nextOffset (null at the end). Filters are applied before pagination. Offsets reflect current data, not a frozen snapshot.', pageSchema), 400: jsonResponse('Invalid pagination, filter, or sort column.', ref('Error')), 404: jsonResponse('Unavailable table.', ref('Error')) } } },
      [`${path}/rows`]: { post: { operationId: 'createTableRow', summary: `Create a row in ${table.name}`, requestBody: requestBody(false), responses: { 201: jsonResponse('Created row.', ref('RowResult')), 400: jsonResponse('Invalid values; no write.', ref('Error')), 404: jsonResponse('Unavailable table.', ref('Error')) } } },
      [`${path}/rows/{rowId}`]: {
        patch: { operationId: 'updateTableRow', summary: 'Update a row with optimistic concurrency control', parameters: [rowParam], requestBody: requestBody(true), responses: { 200: jsonResponse('Updated row.', ref('RowResult')), 400: jsonResponse('Invalid values; no write.', ref('Error')), 404: jsonResponse('Unavailable record.', ref('Error')), 409: jsonResponse('Row changed; reload before retrying.', ref('Error')) } },
        delete: { operationId: 'deleteTableRow', summary: 'Delete a row with optimistic concurrency control', parameters: [rowParam, orgQuery, { name: 'expectedUpdatedAt', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } }], responses: { 200: jsonResponse('Deleted row and its previous snapshot.', ref('DeleteResult')), 404: jsonResponse('Unavailable record.', ref('Error')), 409: jsonResponse('Row changed or is referenced; not deleted.', ref('Error')) } },
      },
    },
  };
}
