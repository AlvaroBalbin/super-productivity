'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const readScss = (file) =>
  readFileSync(join(__dirname, '..', file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// AI-assisted regression for #8830. These are the two outliers named in the
// report, not a repository-wide migration requirement. The styling guide
// requires z-index variables; this checks that contract, not browser stacking.
const cases = [
  {
    file: 'src/app/ui/inline-input/inline-input.component.scss',
    selector: 'input',
  },
  {
    file: 'src/app/features/schedule/schedule-week/schedule-week.component.scss',
    selector: '.drag-time-preview',
  },
];

for (const { file, selector } of cases) {
  test(`${file}: ${selector} uses a shared z-index token (#8830)`, () => {
    const source = readScss(file);
    const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Both rules declare their layer before any nested selectors.
    const rule = source.match(new RegExp(`^${escapedSelector}\\s*\\{([^{}]*)`, 'm'));
    assert.ok(rule, `Missing ${selector} rule; update the regression's selector`);
    const declaration = rule[1].match(/\bz-index\s*:\s*([^;]+);/);
    assert.ok(declaration, `${selector} must declare its layer`);
    const value = declaration[1].trim();
    assert.match(
      value,
      /^var\(--z-[\w-]+\)$/,
      `${selector} uses ${value}; its layer must be controlled by a shared --z-* token`,
    );

    const token = value.slice(4, -1);
    assert.match(
      readScss('src/styles/_css-variables.scss'),
      new RegExp(`${token}\\s*:`),
      `${token} must exist in the shared design tokens`,
    );
  });
}
