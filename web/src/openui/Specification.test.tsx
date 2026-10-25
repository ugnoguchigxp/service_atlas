import { expect, test } from 'vitest';
import { compileSpecification } from './Specification';

test('the installed OpenUI parser accepts the host-bound specification reference', () => {
  const source = 'f42368ad-3251-4503-8f90-da0e568b657b';
  const {parsed} = compileSpecification(source);
  expect(parsed.root?.typeName).toBe('ApiSpecification');
  expect(parsed.root?.props.request).toEqual({source});
  expect(parsed.meta.errors).toEqual([]);
  expect(parsed.root?.partial).toBe(false);
});
test('rejects arbitrary identifiers before building a display definition', () => {
  expect(() => compileSpecification('untrusted\") OtherComponent()')).toThrow();
});
