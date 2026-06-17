import { describe, it, expect } from 'vitest';
import { HOST_NAME, EXTENSION_ID, GECKO_ID } from './contract';

// Guards on the native-messaging identifiers — a typo here silently breaks the
// browser↔host connection, so lock their shape.
describe('native-messaging contract', () => {
  it('host name is a reverse-DNS string', () => {
    expect(HOST_NAME).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
  });

  it('Chromium id is 32 lowercase a–p chars', () => {
    expect(EXTENSION_ID).toMatch(/^[a-p]{32}$/);
  });

  it('Firefox id is an email-style gecko id', () => {
    expect(GECKO_ID).toMatch(/^[^@\s]+@[^@\s]+$/);
  });
});
