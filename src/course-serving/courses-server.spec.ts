import { describe, expect, it } from 'vitest';

import { injectBridge } from './courses-server.js';

const BRIDGE = '<script src="http://localhost:3100/bridge.js"></script>';

/**
 * Bridge injection has to match the shell's dev server exactly, or a course
 * works in development and breaks in production. The charset case is the one
 * that caught the shell out: the Docker worksheets are fragments with no
 * <head>, so there is nothing to inject into.
 */
describe('injectBridge', () => {
  it('injects into <head> when there is one', () => {
    const html = injectBridge('<html><head><title>x</title></head><body></body></html>', BRIDGE);

    expect(html).toContain(`<head>\n${BRIDGE}`);
    expect(html.indexOf(BRIDGE)).toBeLessThan(html.indexOf('<title>'));
  });

  it('keeps attributes on the head tag', () => {
    const html = injectBridge('<head lang="en"><title>x</title></head>', BRIDGE);

    expect(html).toContain('<head lang="en">');
    expect(html).toContain(BRIDGE);
  });

  it('is not fooled by <header>', () => {
    // `<head[^>]*>` would match <header> and inject into the body.
    const html = injectBridge('<body><header>nav</header></body>', BRIDGE);

    expect(html).not.toContain('<header>\n<script');
  });

  it('injects after the charset meta when there is no head', () => {
    // A worksheet, as the Docker course actually ships them.
    const html = injectBridge('<meta charset="utf-8">\n<title>Session 1</title>', BRIDGE);

    // The charset declaration must stay first: a charset declared late is a
    // charset ignored.
    expect(html.indexOf('charset')).toBeLessThan(html.indexOf(BRIDGE));
    expect(html.indexOf(BRIDGE)).toBeLessThan(html.indexOf('<title>'));
  });

  it('prepends when there is neither head nor charset', () => {
    const html = injectBridge('<p>bare fragment</p>', BRIDGE);

    expect(html.startsWith(BRIDGE)).toBe(true);
  });

  it('injects exactly once', () => {
    const html = injectBridge('<head></head><meta charset="utf-8">', BRIDGE);

    expect(html.split('bridge.js').length - 1).toBe(1);
  });
});
