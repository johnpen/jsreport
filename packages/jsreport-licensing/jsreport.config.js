
const schema = {
  type: 'object',
  properties: {
    licenseKey: { type: 'string' },
    useSavedLicenseInfo: { type: 'boolean', default: true },
    licenseInfoPath: { type: 'string' },
    development: { tyle: 'boolean', default: false }
  }
}

module.exports = {
  name: 'licensing',
  main: 'lib/licensing.js',
  optionsSchema: {
    'license-key': { type: 'string' },
    licenseKey: { type: 'string' },
    ...schema,
    extensions: {
      'licensing': schema
    }
  },
  dependencies: [],
  requires: {
    core: '2.x.x',
    studio: '2.x.x'
  },
  skipInExeRender: true
}