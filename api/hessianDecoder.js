const zlib = require('zlib');

/**
 * Decodes a GCP Datastore Hessian/Deflation-wrapped binary blob.
 *
 * Outer envelope format:
 *   01 45                        → Hessian 2.0 envelope header ('E', version 1)
 *   [1-byte len] [class name]    → "com.caucho.hessian.io.Deflation"
 *   90 42 [2-byte big-endian]    → type-ref, Binary marker 'B', payload length
 *   78 9C ...                    → zlib-compressed Hessian 1.0 packet
 *
 * Inner packet format (after decompression):
 *   70 02 00                     → Hessian 1.0 reply packet header ('p', version 2.0)
 *   48 'H'                       → untyped map start
 *   [key/value pairs]            → alternating Hessian-typed values (may be nested maps)
 *   5A 'Z'                       → map end
 *
 * Supported value types:
 *   Null    : 0x4e 'N'
 *   Boolean : 0x54 'T' / 0x46 'F' (full), 0xf9 / 0xf8 (compact)
 *   Integer : 0x80-0xbf (1-byte), 0xc0-0xcf (2-byte), 0xd0-0xd7 (3-byte), 0x49 'I' (4-byte)
 *   Long    : 0x4A 'J' (8-byte), 0xe0-0xef (compact 1-byte: val = b - 0xe8)
 *   Date    : 0x4A 'J' → auto-detected and converted to ISO string if plausible epoch ms
 *   String  : 0x00-0x1f (short, len=b), 0x79 (medium, 1-byte len follows),
 *             0x30-0x34 (medium, 2-byte len), 0x53 'S' (long, 2-byte len)
 *   Map     : 0x48 'H' (untyped, nested, terminated by 0x5a 'Z')
 */
function decodeHessianDeflation(base64Input) {
  // --- Step 1: Decode base64 (tolerate missing padding) ---
  const padded = base64Input.padEnd(
    base64Input.length + (4 - (base64Input.length % 4)) % 4,
    '='
  );
  const buf = Buffer.from(padded, 'base64');

  // --- Step 2: Validate the outer Hessian envelope ---
  if (buf[0] !== 0x01 || buf[1] !== 0x45) {
    throw new Error(
      `Unexpected envelope header: 0x${buf[0].toString(16)} 0x${buf[1].toString(16)} (expected 0x01 0x45)`
    );
  }

  const classNameLen = buf[2];
  const className = buf.subarray(3, 3 + classNameLen).toString('utf8');
  if (!className.includes('Deflat')) {
    throw new Error(`Unexpected class: "${className}". Expected a Deflation wrapper.`);
  }

  // --- Step 3: Locate and extract the zlib payload ---
  // Layout after class name: [90 type-ref] [42 'B' binary marker] [2-byte length]
  const binaryMarkerOffset = 3 + classNameLen + 1; // +1 to skip type-ref 0x90
  if (buf[binaryMarkerOffset] !== 0x42) {
    throw new Error(
      `Expected binary marker 'B' (0x42) at offset ${binaryMarkerOffset}, got 0x${buf[binaryMarkerOffset].toString(16)}`
    );
  }
  const declaredLength = buf.readUInt16BE(binaryMarkerOffset + 1);
  const zlibData = buf.subarray(binaryMarkerOffset + 3);

  console.log(`✅ Class   : ${className}`);
  console.log(`📦 Payload : declared ${declaredLength} bytes | available ${zlibData.length} bytes`);
  if (zlibData.length < declaredLength) {
    console.warn(`⚠️  Truncated by ${declaredLength - zlibData.length} bytes — recovering with sync-flush`);
  }

  // --- Step 4: Decompress ---
  // When truncated: strip the 2-byte zlib header (78 9C) and append the deflate
  // sync-flush marker (00 00 FF FF) so inflateRaw yields all decoded bytes so far.
  let decompressed;
  if (zlibData.length >= declaredLength) {
    decompressed = zlib.inflateSync(zlibData.subarray(0, declaredLength));
  } else {
    const syncFlushPayload = Buffer.concat([
      zlibData.subarray(2),
      Buffer.from([0x00, 0x00, 0xff, 0xff]),
    ]);
    decompressed = zlib.inflateRawSync(syncFlushPayload);
  }
  console.log(`📂 Decompressed: ${decompressed.length} bytes\n`);

  // --- Step 5: Parse the inner Hessian 1.0 packet ---
  if (decompressed[0] !== 0x70) {
    throw new Error(
      `Unexpected inner packet type: 0x${decompressed[0].toString(16)} (expected 0x70 'p')`
    );
  }
  if (decompressed[3] !== 0x48) {
    throw new Error(
      `Expected map marker 'H' (0x48) at byte 3, got 0x${decompressed[3].toString(16)}`
    );
  }

  let pos = 4; // skip 'p' 02 00 'H'

  // MAX plausible Unix epoch in ms (year 2100-01-01)
  const MAX_DATE_MS = 4102444800000n;

  function readValue() {
    const b = decompressed[pos];

    // --- Null ---
    if (b === 0x4e) { pos += 1; return null; }

    // --- Boolean: full markers ---
    if (b === 0x54) { pos += 1; return true; }
    if (b === 0x46) { pos += 1; return false; }

    // --- Boolean: compact (Hessian 1.0 extension) ---
    if (b === 0xf9) { pos += 1; return true; }
    if (b === 0xf8) { pos += 1; return false; }

    // --- Long / Date: 'J' + 8 bytes big-endian ---
    if (b === 0x4a) {
      const hi = decompressed.readUInt32BE(pos + 1);
      const lo = decompressed.readUInt32BE(pos + 5);
      pos += 9;
      const ms = (BigInt(hi) << 32n) | BigInt(lo);
      // Auto-convert to ISO date string when value looks like a plausible epoch timestamp
      if (ms >= 0n && ms <= MAX_DATE_MS) {
        return new Date(Number(ms)).toISOString();
      }
      return ms.toString();
    }

    // --- Long: compact 1-byte (0xe0-0xef → val = b - 0xe8) ---
    if (b >= 0xe0 && b <= 0xef) { pos += 1; return b - 0xe8; }

    // --- Integer: compact 1-byte (0x80-0xbf → val = b - 0x90) ---
    if (b >= 0x80 && b <= 0xbf) { pos += 1; return b - 0x90; }

    // --- Integer: compact 2-byte (0xc0-0xcf) ---
    if (b >= 0xc0 && b <= 0xcf) {
      const val = ((b - 0xc8) << 8) | decompressed[pos + 1];
      pos += 2;
      return val;
    }

    // --- Integer: compact 3-byte (0xd0-0xd7) ---
    if (b >= 0xd0 && b <= 0xd7) {
      const val = ((b - 0xd4) << 16) | (decompressed[pos + 1] << 8) | decompressed[pos + 2];
      pos += 3;
      return val;
    }

    // --- Integer: full 4-byte 'I' ---
    if (b === 0x49) {
      const val = decompressed.readInt32BE(pos + 1);
      pos += 5;
      return val;
    }

    // --- Map: 'H' (0x48) — untyped, nested, terminated by 'Z' (0x5a) ---
    if (b === 0x48) {
      pos += 1; // consume 'H'
      const map = {};
      while (pos < decompressed.length && decompressed[pos] !== 0x5a) {
        const key = readValue();
        const val = readValue();
        map[String(key)] = val;
      }
      pos += 1; // consume 'Z'
      return map;
    }

    // --- String: short (0x00-0x1f) → length = b ---
    if (b <= 0x1f) {
      pos += 1;
      const str = decompressed.subarray(pos, pos + b).toString('utf8');
      pos += b;
      return str;
    }

    // --- String: compact with 1-byte length (0x79) → next byte is length (0-255) ---
    // Observed in practice for strings length 32-255 that fall outside the 0x00-0x1f range.
    if (b === 0x79) {
      const len = decompressed[pos + 1];
      pos += 2;
      const str = decompressed.subarray(pos, pos + len).toString('utf8');
      pos += len;
      return str;
    }

    // --- String: medium (0x30-0x34) → length = (b - 0x30) * 256 + next ---
    if (b >= 0x30 && b <= 0x34) {
      const len = (b - 0x30) * 256 + decompressed[pos + 1];
      pos += 2;
      const str = decompressed.subarray(pos, pos + len).toString('utf8');
      pos += len;
      return str;
    }

    // --- String: long 'S' (0x53) → 2-byte big-endian length ---
    if (b === 0x53) {
      const len = decompressed.readUInt16BE(pos + 1);
      pos += 3;
      const str = decompressed.subarray(pos, pos + len).toString('utf8');
      pos += len;
      return str;
    }

    // --- Double: 'D' (0x44) ---
    if (b === 0x44) {
      const val = decompressed.readDoubleBE(pos + 1);
      pos += 9;
      return val;
    }

    // --- Typed Map: 'M' (0x4d) ---
    // Similar to 'H', but contains a type definition first
    if (b === 0x4d) {
      pos += 1; // consume 'M'
      
      // Read the type string (usually a 't' 0x74 followed by 16-bit length)
      if (decompressed[pos] === 0x74) {
        pos += 1;
        const tLen = decompressed.readUInt16BE(pos);
        pos += 2;
        const mapType = decompressed.subarray(pos, pos + tLen).toString('utf8');
        pos += tLen;
      }

      const map = {};
      while (pos < decompressed.length && decompressed[pos] !== 0x5a) { // 'Z' end
        const key = readValue();
        const val = readValue();
        map[String(key)] = val;
      }
      pos += 1; // consume 'Z'
      return map;
    }

    // --- List / Array: 'V' (0x56) ---
    if (b === 0x56) {
      pos += 1; // consume 'V'
      
      // Lists can optionally define a type 't'
      if (decompressed[pos] === 0x74) {
        pos += 1;
        const tLen = decompressed.readUInt16BE(pos); pos += 2 + tLen;
      }
      // Lists can optionally define a length 'l'
      if (decompressed[pos] === 0x6c) {
        pos += 1 + 4; // consume 'l' and 4-byte int
      }

      const list = [];
      while (pos < decompressed.length && decompressed[pos] !== 0x7a) { // 'z' end of list
        list.push(readValue());
      }
      pos += 1; // consume 'z'
      return list;
    }

    throw new Error(
      `Unknown Hessian type marker 0x${b.toString(16)} at position ${pos} ` +
      `(context: ...${Array.from(decompressed.subarray(Math.max(0, pos - 3), pos + 4))
        .map(x => x.toString(16).padStart(2, '0')).join(' ')}...)`
    );
  }

  // --- Step 6: Walk the top-level map key/value pairs until 'Z' ---
  const result = {};
  while (pos < decompressed.length) {
    if (decompressed[pos] === 0x5a) break; // 'Z' = end of map
    const key = readValue();
    const value = readValue();
    result[String(key)] = value;
  }

  return result;
}


module.exports = { decodeHessianDeflation };
