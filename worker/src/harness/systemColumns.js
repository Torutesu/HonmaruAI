// Display/query metadata is separate from editable table schemas.
export const SYSTEM_COLUMN_IDS = ['$row.id', '$row.createdAt', '$row.updatedAt'];
export const isSystemTimestamp = id => id === '$row.createdAt' || id === '$row.updatedAt';
export const queryValue = (row, id) => id === '$row.id' ? row.id : id === '$row.createdAt' ? row.createdAt : id === '$row.updatedAt' ? row.updatedAt : row.values[id];
