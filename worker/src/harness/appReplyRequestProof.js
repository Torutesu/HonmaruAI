// Policy fingerprints are produced by skillPolicyProof's D1 json_object.
// A missing trusted IP must not be treated as an allowed network when a
// deferred HTTP job runs outside its original async request context.
export function annotationProofRequiresIp(fingerprint) {
 try {
  const value=JSON.parse(fingerprint).network;
  const network=typeof value==='string'?JSON.parse(value):value;
  return Boolean(network?.enforce);
 } catch { return true; }
}
