const zlib = require('zlib');

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
  const className = buf.subarray(3, 3 + classNameLen).toString('utf8');
  
  // --- Step 3: Locate and extract the zlib payload ---
  const binaryMarkerOffset = 3 + classNameLen + 1; 
  if (buf[binaryMarkerOffset] !== 0x42) {
    throw new Error(`Expected binary marker 'B' (0x42)`);
  }
  
  const declaredLength = buf.readUInt16BE(binaryMarkerOffset + 1);
  const zlibData = buf.subarray(binaryMarkerOffset + 3);

  // --- Step 4: Decompress ---
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

  // --- Step 5: Parse the inner Hessian 1.0 packet ---
  if (decompressed[0] !== 0x70) throw new Error(`Unexpected inner packet type: 0x${decompressed[0].toString(16)}`);
  if (decompressed[3] !== 0x48) throw new Error(`Expected map marker 'H' (0x48) at byte 3`);

  let pos = 4; // skip 'p' 02 00 'H'
  const MAX_DATE_MS = 4102444800000n;

  function readValue() {
    if (pos >= decompressed.length) return undefined;
    const b = decompressed[pos];

    // --- Null ---
    if (b === 0x4e) { pos += 1; return null; }

    // --- Boolean ---
    if (b === 0x54 || b === 0xf9) { pos += 1; return true; }
    if (b === 0x46 || b === 0xf8) { pos += 1; return false; }

    // --- Double: 'D' (0x44) ---
    if (b === 0x44) {
      const val = decompressed.readDoubleBE(pos + 1);
      pos += 9;
      return val;
    }

    // --- Date: 'd' (0x64) ---
    if (b === 0x64) {
      const hi = decompressed.readUInt32BE(pos + 1);
      const lo = decompressed.readUInt32BE(pos + 5);
      pos += 9;
      const ms = (BigInt(hi) << 32n) | BigInt(lo);
      return new Date(Number(ms)).toISOString();
    }

    // --- Long / Date: 'J' (0x4A) ---
    if (b === 0x4a) {
      const hi = decompressed.readUInt32BE(pos + 1);
      const lo = decompressed.readUInt32BE(pos + 5);
      pos += 9;
      const ms = (BigInt(hi) << 32n) | BigInt(lo);
      if (ms >= 0n && ms <= MAX_DATE_MS) {
        return new Date(Number(ms)).toISOString();
      }
      return ms.toString();
    }

    // --- Compact Integers & Longs ---
    if (b >= 0xe0 && b <= 0xef) { pos += 1; return b - 0xe8; }
    if (b >= 0x80 && b <= 0xbf) { pos += 1; return b - 0x90; }
    if (b >= 0xc0 && b <= 0xcf) {
      const val = ((b - 0xc8) << 8) | decompressed[pos + 1];
      pos += 2;
      return val;
    }
    if (b >= 0xd0 && b <= 0xd7) {
      const val = ((b - 0xd4) << 16) | (decompressed[pos + 1] << 8) | decompressed[pos + 2];
      pos += 3;
      return val;
    }
    if (b === 0x49) {
      const val = decompressed.readInt32BE(pos + 1);
      pos += 5;
      return val;
    }

    // --- Untyped Map: 'H' (0x48) ---
    if (b === 0x48) {
      pos += 1; 
      const map = {};
      while (pos < decompressed.length && decompressed[pos] !== 0x5a) {
        const key = readValue();
        const val = readValue();
        map[String(key)] = val;
      }
      pos += 1; 
      return map;
    }

    // --- Typed Map: 'M' (0x4d) ---
    if (b === 0x4d) {
      pos += 1; 
      if (decompressed[pos] === 0x74) { // 't' type definition
        pos += 1;
        const tLen = decompressed.readUInt16BE(pos);
        pos += 2 + tLen; // skip type string
      }
      const map = {};
      while (pos < decompressed.length && decompressed[pos] !== 0x5a) { // 'Z'
        const key = readValue();
        const val = readValue();
        map[String(key)] = val;
      }
      pos += 1; 
      return map;
    }

    // --- List / Array: 'V' (0x56) ---
    if (b === 0x56) {
      pos += 1; 
      if (decompressed[pos] === 0x74) { // 't' type definition
        pos += 1;
        const tLen = decompressed.readUInt16BE(pos); 
        pos += 2 + tLen;
      }
      if (decompressed[pos] === 0x6c) { // 'l' length definition
        pos += 1 + 4; 
      }
      const list = [];
      while (pos < decompressed.length && decompressed[pos] !== 0x7a) { // 'z'
        list.push(readValue());
      }
      pos += 1; 
      return list;
    }

    // --- Strings ---
    if (b <= 0x1f) {
      pos += 1;
      const str = decompressed.subarray(pos, pos + b).toString('utf8');
      pos += b;
      return str;
    }
    if (b === 0x79) {
      const len = decompressed[pos + 1];
      pos += 2;
      const str = decompressed.subarray(pos, pos + len).toString('utf8');
      pos += len;
      return str;
    }
    if (b >= 0x30 && b <= 0x34) {
      const len = (b - 0x30) * 256 + decompressed[pos + 1];
      pos += 2;
      const str = decompressed.subarray(pos, pos + len).toString('utf8');
      pos += len;
      return str;
    }
    if (b === 0x53) {
      const len = decompressed.readUInt16BE(pos + 1);
      pos += 3;
      const str = decompressed.subarray(pos, pos + len).toString('utf8');
      pos += len;
      return str;
    }

    throw new Error(
      `Unknown Hessian type marker 0x${b.toString(16)} at position ${pos} ` +
      `(context: ...${Array.from(decompressed.subarray(Math.max(0, pos - 3), pos + 4))
        .map(x => x.toString(16).padStart(2, '0')).join(' ')}...)`
    );
  }

  // --- Step 6: Walk the top-level map ---
  const result = {};
  while (pos < decompressed.length && decompressed[pos] !== 0x5a) {
    const key = readValue();
    const value = readValue();
    result[String(key)] = value;
  }

  return result;
}
