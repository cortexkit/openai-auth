import assert from 'node:assert/strict'
import { redactCredentialError } from '../packages/core/src/util/credential-redaction'

const credential = 'relay-attempt-credential-7f3e9a1c2b'
const body = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(credential))
    controller.close()
  },
})
const out = redactCredentialError({ body }, credential)
assert.equal(Object.getOwnPropertyDescriptor(out, 'body'), undefined)
console.log(
  `${process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`}: thrown-stream-slot 1 check passed`,
)
