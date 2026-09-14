'use strict';

/*
  Loads the licensing module.

  Two builds exist. `walaa-license.node` embeds the vendor's public key and is the only
  one staging copies into a shop's runtime. `walaa-license.test.node` embeds the
  published TEST key and can sign with it; the API's test suite (which vitest marks with
  VITEST) loads it. On a shop machine the test build is not present, so setting VITEST
  there loads nothing and every licensing call fails — it can never fall back to
  trusting the test key.

  The exports are assigned one by one so every loader sees them by name: Node's ESM
  import of a CommonJS module, vitest, and the esbuild bundle all read `exports.x = …`.

  A missing module does not throw here. The service would then die inside an import,
  before it can record a reason, and the dashboard would show a blank failure; instead
  each function throws a sentence the startup-error record carries to the screen.
*/
const { existsSync } = require('node:fs');
const { join } = require('node:path');

const file = process.env.VITEST ? 'walaa-license.test.node' : 'walaa-license.node';
const path = join(__dirname, file);

const MISSING =
  'تعذّر تشغيل الخدمة: وحدة الترخيص مفقودة من ملفات البرنامج المثبّتة. هذه مشكلة في التثبيت وليست في بياناتك — ' +
  'أعد تثبيت البرنامج من ملف التثبيت الكامل. بيانات المتجر لم تتغيّر.';

let binding = null;
if (existsSync(path)) {
  binding = require(path);
}

function call(name) {
  return (...args) => {
    if (!binding) throw new Error(MISSING);
    const fn = binding[name];
    if (typeof fn !== 'function') throw new Error(`${name} is not provided by ${file}`);
    return fn(...args);
  };
}

exports.available = binding !== null;
exports.computeDeviceId = call('computeDeviceId');
exports.verifyLicense = call('verifyLicense');
exports.licenseStatus = call('licenseStatus');
exports.resolveAnchors = call('resolveAnchors');
exports.readFileAnchor = call('readFileAnchor');
exports.writeFileAnchor = call('writeFileAnchor');
exports.readRegistryAnchor = call('readRegistryAnchor');
exports.writeRegistryAnchor = call('writeRegistryAnchor');
exports.keyInfo = call('keyInfo');
exports.normalizeCode = call('normalizeCode');
exports.knownFeatures = call('knownFeatures');
exports.signForTests = call('signForTests');
exports.deleteRegistryKeyForTests = call('deleteRegistryKeyForTests');
