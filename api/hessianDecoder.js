const zlib = require('zlib');
const hessian = require('hessian.js');

function decodeHessianDeflation(base64Input) {
  // --- Step 1: Decode base64 (tolerate missing padding) ---
  const padded = base64Input.padEnd(
    base64Input.length + (4 - (base64Input.length % 4)) % 4,
    '='
  );
  const buf = Buffer.from(padded, 'base64');

  // --- Step 2: Validate the outer Hessian envelope ---
  if (buf[0] !== 0x01 || buf[1] !== 0x45) {
    throw new Error(`Unexpected envelope header: 0x${buf[0].toString(16)} 0x${buf[1].toString(16)}`);
  }

  const classNameLen = buf[2];

  // --- Step 3: Locate and extract the zlib payload ---
  const binaryMarkerOffset = 3 + classNameLen + 1;
  if (buf[binaryMarkerOffset] !== 0x42) {
    throw new Error(`Expected binary marker 'B' (0x42)`);
  }

  const zlibData = buf.subarray(binaryMarkerOffset + 3);

  // --- Step 4: Decompress (zlib inflate) ---
  const decompressed = zlib.inflateSync(zlibData);

  // --- Step 5: Decode Hessian 2.0 payload ---
  const decoder = new hessian.DecoderV2(decompressed);
  const result = [];

  // Read all items sequentially until buffer is exhausted or a terminator (like 'Z') throws
  while (true) {
    try {
      const val = decoder.read();
      result.push(val);
    } catch (e) {
      break;
    }
  }

  // Attempt to reconstruct a map if the array matches the [ [], key, val, key, val... ] pattern
  if (result.length > 0 && Array.isArray(result[0]) && result[0].length === 0 && result.length % 2 === 1) {
    const map = {};
    for (let i = 1; i < result.length; i += 2) {
      map[String(result[i])] = result[i + 1];
    }
    return map;
  }

  return result.length === 1 ? result[0] : result;
}

module.exports = { decodeHessianDeflation };