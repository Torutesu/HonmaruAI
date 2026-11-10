const encoder = new TextEncoder();

// Result transport is untrusted: a connected execution node must not be able
// to smuggle an unbounded report into run history or claim an arbitrary shape.
export function cleanWorkflowMessageDrafts(value) {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError('Invalid workflow message drafts.');
  let totalBytes = 0;
  const drafts = value.map(draft => {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || Object.keys(draft).some(key => !['text', 'mention'].includes(key))) throw new TypeError('Invalid workflow message draft.');
    if (typeof draft.text !== 'string' || !draft.text.trim() || encoder.encode(draft.text).length > 12000) throw new TypeError('Invalid workflow message text.');
    let mention;
    if (draft.mention !== undefined) {
      const values = Array.isArray(draft.mention) ? draft.mention : [draft.mention];
      if (!values.length || values.length > 25 || values.some(item => typeof item !== 'string' || !item.trim() || item.length > 100)) throw new TypeError('Invalid workflow message mention.');
      mention = Array.isArray(draft.mention) ? values.map(item => item.trim()) : draft.mention.trim();
    }
    const cleaned = { text: draft.text, ...(mention !== undefined ? { mention } : {}) };
    totalBytes += encoder.encode(JSON.stringify(cleaned)).length;
    if (totalBytes > 30000) throw new TypeError('Workflow message drafts exceed the size limit.');
    return cleaned;
  });
  return drafts;
}
