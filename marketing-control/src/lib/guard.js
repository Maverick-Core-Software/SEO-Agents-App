export const READ_ONLY = 'READ_ONLY';
export const MUTATION_METHODS = ['insert', 'update', 'delete', 'upsert', 'rpc'];

const MUTATIONS = new Set(MUTATION_METHODS);
const SOURCE_NEEDLES = ['.insert(', '.update(', '.delete(', '.upsert(', '.rpc('];

export function wrapReadOnly(target) {
  if (target == null || (typeof target !== 'object' && typeof target !== 'function')) {
    return target;
  }
  return new Proxy(target, {
    get(obj, prop) {
      if (typeof prop === 'string' && MUTATIONS.has(prop)) {
        throw new Error(READ_ONLY);
      }
      const value = obj[prop];
      if (typeof value === 'function') {
        return (...args) => wrapReadOnly(value.apply(obj, args));
      }
      return value;
    },
  });
}

export function assertReadOnlySource(sourceText) {
  const text = String(sourceText ?? '');
  return SOURCE_NEEDLES.filter((needle) => text.includes(needle));
}
