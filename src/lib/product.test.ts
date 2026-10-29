import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME, PROJECT_URL } from './product';

describe('product', () => {
  it('names the product and links the project', () => {
    expect(PRODUCT_NAME).toBe('DLM');
    expect(PROJECT_URL).toMatch(/^https:\/\/github\.com\/sabadia\//);
  });
});
