#!/usr/bin/env node
'use strict'

/**
 * Verify the shared credential loader without printing credential values.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  loadLocalCredentials,
  parseCredentials,
  verifyCredentialStructure,
} = require('./onboarding-e2e-lib.cjs')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stride-creds-'))
const fixturePath = path.join(tmpDir, '.credentials.local')
fs.writeFileSync(
  fixturePath,
  [
    '# stride account',
    'email=stride@example.com',
    'password=stridepass',
    '# coros account',
    'email=coros@example.com',
    'password=corospass',
    'invite_code=INV123',
    'user_email=flat@example.com',
  ].join('\n'),
  'utf8',
)

const previousPath = process.env.STRIDE_CREDENTIALS_FILE
try {
  const parsed = parseCredentials(fixturePath)
  assert.ok(parsed.sections.stride.email)
  assert.ok(parsed.sections.stride.password)
  assert.ok(parsed.sections.coros.email)
  assert.ok(parsed.flat.invite_code)
  assert.ok(parsed.flat.email)

  process.env.STRIDE_CREDENTIALS_FILE = fixturePath
  const credentials = loadLocalCredentials()
  assert.ok(credentials.email)
  assert.ok(credentials.password)

  const result = verifyCredentialStructure()
  assert.equal(result.fileFound, true)
  assert.equal(result.hasLocalCreds, true)
  assert.ok(Array.isArray(result.sectionNames))
  assert.ok(Array.isArray(result.flatKeys))

  console.log('Credential loader verification: OK (values not shown)')
} finally {
  if (previousPath === undefined) delete process.env.STRIDE_CREDENTIALS_FILE
  else process.env.STRIDE_CREDENTIALS_FILE = previousPath
  fs.rmSync(tmpDir, { recursive: true, force: true })
}
