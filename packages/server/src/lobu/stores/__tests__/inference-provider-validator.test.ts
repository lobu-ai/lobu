/**
 * Unit tests for the app-layer capability-block validator. This is the full
 * guard above the DB CHECK floor — every capabilities write passes through it.
 * No DB access.
 */

import { describe, expect, it } from 'vitest';
import { validateCapabilityBlock } from '../provider-secrets';

describe('validateCapabilityBlock', () => {
  describe('models_endpoint', () => {
    it('rejects a protocol-relative "//h"', () => {
      expect(
        validateCapabilityBlock('text', { models_endpoint: '//h' })
      ).toBeTruthy();
    });

    it('rejects a backslash path "/\\h"', () => {
      expect(
        validateCapabilityBlock('text', { models_endpoint: '/\\h' })
      ).toBeTruthy();
    });

    it('accepts a clean relative path "/v1/models"', () => {
      expect(
        validateCapabilityBlock('text', { models_endpoint: '/v1/models' })
      ).toBeNull();
    });

    it('accepts the root path "/"', () => {
      expect(validateCapabilityBlock('text', { models_endpoint: '/' })).toBeNull();
    });

    it.each([
      ['absolute URL', 'https://evil/models'],
      ['no leading slash', 'models'],
      ['tab-injected', '/\t//evil'],
      ['space', '/a b'],
    ])('rejects models_endpoint: %s', (_label, models_endpoint) => {
      expect(
        validateCapabilityBlock('text', { models_endpoint })
      ).toBeTruthy();
    });

    it('rejects a non-string models_endpoint', () => {
      expect(
        validateCapabilityBlock('text', {
          models_endpoint: 5 as unknown as string,
        })
      ).toBeTruthy();
    });
  });

  describe('base_url', () => {
    it('rejects http:// (must be https)', () => {
      expect(
        validateCapabilityBlock('text', { base_url: 'http://x' })
      ).toBeTruthy();
    });

    it('rejects userinfo "user:pass@h"', () => {
      expect(
        validateCapabilityBlock('text', { base_url: 'https://user:pass@h' })
      ).toBeTruthy();
    });

    it('rejects a query string "https://h?q=1"', () => {
      expect(
        validateCapabilityBlock('text', { base_url: 'https://h?q=1' })
      ).toBeTruthy();
    });

    it('rejects a fragment "https://h#f"', () => {
      expect(
        validateCapabilityBlock('text', { base_url: 'https://h#f' })
      ).toBeTruthy();
    });

    it.each([
      ['not a URL', '://nope'],
      ['empty string', ''],
    ])('rejects base_url: %s', (_label, base_url) => {
      expect(validateCapabilityBlock('text', { base_url })).toBeTruthy();
    });

    it('accepts a clean https base_url', () => {
      expect(
        validateCapabilityBlock('text', {
          base_url: 'https://api.example.com/v1',
        })
      ).toBeNull();
    });
  });

  describe('model', () => {
    it('rejects a non-string model', () => {
      expect(
        validateCapabilityBlock('text', { model: 42 as unknown as string })
      ).toBeTruthy();
    });

    it('rejects an empty-string model', () => {
      expect(validateCapabilityBlock('text', { model: '' })).toBeTruthy();
    });

    it('rejects a whitespace-only model', () => {
      expect(validateCapabilityBlock('text', { model: '  ' })).toBeTruthy();
    });

    it('accepts { model: "x" }', () => {
      expect(validateCapabilityBlock('text', { model: 'x' })).toBeNull();
    });
  });

  describe('shape', () => {
    it('rejects an unknown block key', () => {
      expect(
        validateCapabilityBlock('text', { foo: 'bar' } as unknown)
      ).toBeTruthy();
    });

    it('rejects an unknown modality', () => {
      expect(validateCapabilityBlock('vision', {})).toBeTruthy();
    });

    it('rejects a non-object block', () => {
      expect(validateCapabilityBlock('text', 'nope' as unknown)).toBeTruthy();
      expect(validateCapabilityBlock('text', null)).toBeTruthy();
      expect(validateCapabilityBlock('text', [] as unknown)).toBeTruthy();
    });

    it('accepts an empty block for a known modality', () => {
      expect(validateCapabilityBlock('text', {})).toBeNull();
    });

    it('accepts a full valid block', () => {
      expect(
        validateCapabilityBlock('text', {
          base_url: 'https://api.example.com',
          model: 'gpt-x',
          models_endpoint: '/v1/models',
        })
      ).toBeNull();
    });
  });
});
