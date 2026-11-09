/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appPathname, publicUrl } from './public-url.js';

describe('publicUrl', () => {
  it('is a no-op at the domain root (the default outside Vite)', () => {
    assert.equal(publicUrl('/samples/hello-wall.ifc'), '/samples/hello-wall.ifc');
    assert.equal(publicUrl('/samples/a.ifc', '/'), '/samples/a.ifc');
  });

  it('prefixes the mount subpath, with or without its trailing slash', () => {
    assert.equal(publicUrl('/samples/a.ifc', '/Viewer/'), '/Viewer/samples/a.ifc');
    assert.equal(publicUrl('samples/a.ifc', '/Viewer'), '/Viewer/samples/a.ifc');
    assert.equal(publicUrl('/', '/Viewer/'), '/Viewer/');
  });
});

describe('appPathname', () => {
  it('leaves the pathname alone at the domain root', () => {
    assert.equal(appPathname('/mcp/playground'), '/mcp/playground');
    assert.equal(appPathname('/mcp', '/'), '/mcp');
  });

  it('strips the mount subpath so routes match as at the root', () => {
    assert.equal(appPathname('/Viewer/', '/Viewer/'), '/');
    assert.equal(appPathname('/Viewer', '/Viewer/'), '/');
    assert.equal(appPathname('/Viewer/mcp', '/Viewer/'), '/mcp');
    assert.equal(appPathname('/Viewer/mcp/playground/', '/Viewer/'), '/mcp/playground/');
  });

  it('does not strip a lookalike prefix', () => {
    assert.equal(appPathname('/ViewerX/mcp', '/Viewer/'), '/ViewerX/mcp');
  });
});
