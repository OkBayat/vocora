import assert from "node:assert/strict";
import { it } from "node:test";
import { createErrorHandler } from "../src/interfaces/http/errorHandler.js";

it("forwards errors when response headers have already been sent", () => {
  const expected = new Error("stream failed");
  let forwarded = null;
  const handler = createErrorHandler({ logger: { error() {} } });

  handler(expected, {}, { headersSent: true }, (error) => {
    forwarded = error;
  });

  assert.equal(forwarded, expected);
});
