/*! noble-ed25519 - MIT License (c) Paul Miller (paulmillr.com) */

// Thanks DJB https://ed25519.cr.yp.to
// https://tools.ietf.org/html/rfc8032, https://en.wikipedia.org/wiki/EdDSA
// Includes Ristretto. https://ristretto.group

const CURVE = {
  // Params: a, b
  a: -1n,
  // Equal to -121665/121666 over finite field.
  // Negative number is P - number, and division is invert(number, P)
  d: 37095705934669439343138083508754565189542113879843219016388785533085940283555n,
  // Finite field 𝔽p over which we'll do calculations
  P: 2n ** 255n - 19n,
  // Subgroup order aka C
  n: 2n ** 252n + 27742317777372353535851937790883648493n,
  // Cofactor
  h: 8n,
  // Base point (x, y) aka generator point
  Gx: 15112221349535400772501151409588531511454012693041857206046113283949847762202n,
  Gy: 46316835694926478169428394003475163141307993866256225615783033603165251855960n,
};

// Cleaner output this way.
export { CURVE };

type Hex = Uint8Array | string;
type PrivKey = Hex | bigint | number;
type PubKey = Hex | Point;
type SigType = Hex | Signature;
const B32 = 32;

// 2^((p-1)/4)
const SQRT_M1 = 19681161376707505956807079304988542015446066515923890162744021073123829784752n;

// 1 / sqrt(a-d)
const INVSQRT_A_D = 54469307008909316920995813868745141605393597292927456921205312896311721017578n;

// sqrt(a*d - 1)
const SQRD_AD_ONE = 25063068953384623474111414158702152701244531502492656460079210482610430750235n;

// Default Point works in default aka affine coordinates: (x, y)
// Extended Point works in extended coordinates: (x, y, z, t) ∋ (x=x/z, y=y/z, t=xy)
// https://en.wikipedia.org/wiki/Twisted_Edwards_curve#Extended_coordinates
class ExtendedPoint {
  constructor(public x: bigint, public y: bigint, public z: bigint, public t: bigint) {}

  static BASE = new ExtendedPoint(CURVE.Gx, CURVE.Gy, 1n, mod(CURVE.Gx * CURVE.Gy));
  static ZERO = new ExtendedPoint(0n, 1n, 1n, 0n);
  static fromAffine(p: Point): ExtendedPoint {
    if (!(p instanceof Point)) {
      throw new TypeError('ExtendedPoint#fromAffine: expected Point');
    }
    if (p.equals(Point.ZERO)) return ExtendedPoint.ZERO;
    return new ExtendedPoint(p.x, p.y, 1n, mod(p.x * p.y));
  }
  // Takes a bunch of Jacobian Points but executes only one
  // invert on all of them. invert is very slow operation,
  // so this improves performance massively.
  static toAffineBatch(points: ExtendedPoint[]): Point[] {
    const toInv = invertBatch(points.map((p) => p.z));
    return points.map((p, i) => p.toAffine(toInv[i]));
  }

  static normalizeZ(points: ExtendedPoint[]): ExtendedPoint[] {
    return this.toAffineBatch(points).map(this.fromAffine);
  }

  // Ristretto-related methods.

  // The hash-to-group operation applies Elligator twice and adds the results.
  static fromRistrettoHash(hash: Uint8Array): ExtendedPoint {
    const r1 = bytesToNumberRst(hash.slice(0, B32));
    const R1 = this.elligatorRistrettoFlavor(r1);
    const r2 = bytesToNumberRst(hash.slice(B32, B32 * 2));
    const R2 = this.elligatorRistrettoFlavor(r2);
    return R1.add(R2);
  }

  // Computes the Ristretto Elligator map.
  // This method is not public because it's just used for hashing
  // to a point -- proper elligator support is deferred for now.
  private static elligatorRistrettoFlavor(r0: bigint) {
    const { d } = CURVE;
    const oneMinusDSq = mod(1n - d ** 2n);
    const dMinusOneSq = (d - 1n) ** 2n;
    const r = SQRT_M1 * (r0 * r0);
    const NS = mod((r + 1n) * oneMinusDSq);
    let c = mod(-1n);
    const D = mod((c - d * r) * mod(r + d));
    let { isNotZeroSquare, value: S } = sqrtRatio(NS, D);
    let sPrime = mod(S * r0);
    sPrime = edIsNegative(sPrime) ? sPrime : mod(-sPrime);
    S = isNotZeroSquare ? S : sPrime;
    c = isNotZeroSquare ? c : r;
    const NT = c * (r - 1n) * dMinusOneSq - D;
    const sSquared = S * S;
    const W0 = (S + S) * D;
    const W1 = NT * SQRD_AD_ONE;
    const W2 = 1n - sSquared;
    const W3 = 1n + sSquared;
    return new ExtendedPoint(mod(W0 * W3), mod(W2 * W1), mod(W1 * W3), mod(W0 * W2));
  }

  static fromRistrettoBytes(bytes: Uint8Array) {
    // Step 1. Check s for validity:
    // 1.a) s must be 32 bytes (we get this from the type system)
    // 1.b) s < p
    // 1.c) s is nonnegative
    //
    // Our decoding routine ignores the high bit, so the only
    // possible failure for 1.b) is if someone encodes s in 0..18
    // as s+p in 2^255-19..2^255-1.  We can check this by
    // converting back to bytes, and checking that we get the
    // original input, since our encoding routine is canonical.
    const s = bytesToNumberRst(bytes);
    const sEncodingIsCanonical = equalBytes(numberToBytesPadded(s, B32), bytes);
    const sIsNegative = edIsNegative(s);
    if (!sEncodingIsCanonical || sIsNegative) {
      throw new Error('Cannot convert bytes to Ristretto Point');
    }
    const s2 = s * s;
    const u1 = 1n - s2; // 1 + as²
    const u2 = 1n + s2; // 1 - as² where a=-1
    const squaredU2 = u2 * u2; // (1 - as²)²
    // v == ad(1+as²)² - (1-as²)² where d=-121665/121666
    const v = u1 * u1 * -CURVE.d - squaredU2;
    const { isNotZeroSquare, value: I } = invertSqrt(mod(v * squaredU2)); // 1/sqrt(v*u_2²)
    const Dx = I * u2;
    const Dy = I * Dx * v; // 1/u2
    // x == | 2s/sqrt(v) | == + sqrt(4s²/(ad(1+as²)² - (1-as²)²))
    let x = mod((s + s) * Dx);
    if (edIsNegative(x)) x = mod(-x);
    // y == (1-as²)/(1+as²)
    const y = mod(u1 * Dy);
    // t == ((1+as²) sqrt(4s²/(ad(1+as²)² - (1-as²)²)))/(1-as²)
    const t = mod(x * y);
    if (!isNotZeroSquare || edIsNegative(t) || y === 0n) {
      throw new Error('Cannot convert bytes to Ristretto Point');
    }
    return new ExtendedPoint(x, y, 1n, t);
  }

  toRistrettoBytes() {
    let { x, y, z, t } = this;
    // u1 = (z0 + y0) * (z0 - y0)
    const u1 = (z + y) * (z - y);
    const u2 = x * y;
    // Ignore return value since this is always square
    const { value: invsqrt } = invertSqrt(mod(u2 ** 2n * u1));
    const i1 = invsqrt * u1;
    const i2 = invsqrt * u2;
    const invz = i1 * i2 * t;
    let invDeno = i2;
    if (edIsNegative(t * invz)) {
      // Is rotated
      const iX = mod(x * SQRT_M1);
      const iY = mod(y * SQRT_M1);
      x = iY;
      y = iX;
      invDeno = mod(i1 * INVSQRT_A_D);
    }
    if (edIsNegative(x * invz)) y = mod(-y);
    let s = mod((z - y) * invDeno);
    if (edIsNegative(s)) s = mod(-s);
    return numberToBytesPadded(s, B32);
  }
  // Ristretto methods end.

  // Compare one point to another.
  equals(other: ExtendedPoint): boolean {
    const a = this;
    const b = other;
    const [T1, T2, Z1, Z2] = [a.t, b.t, a.z, b.z];
    return mod(T1 * Z2) === mod(T2 * Z1);
  }

  // Inverses point to one corresponding to (x, -y) in Affine coordinates.
  negate(): ExtendedPoint {
    return new ExtendedPoint(mod(-this.x), this.y, this.z, mod(-this.t));
  }

  // Fast algo for doubling Extended Point when curve's a=-1.
  // http://hyperelliptic.org/EFD/g1p/auto-twisted-extended-1.html#doubling-dbl-2008-hwcd
  // Cost: 3M + 4S + 1*a + 7add + 1*2.
  double(): ExtendedPoint {
    const X1 = this.x;
    const Y1 = this.y;
    const Z1 = this.z;
    const { a } = CURVE;
    const A = mod(X1 ** 2n);
    const B = mod(Y1 ** 2n);
    const C = mod(2n * Z1 ** 2n);
    const D = mod(a * A);
    const E = mod((X1 + Y1) ** 2n - A - B);
    const G = mod(D + B);
    const F = mod(G - C);
    const H = mod(D - B);
    const X3 = mod(E * F);
    const Y3 = mod(G * H);
    const T3 = mod(E * H);
    const Z3 = mod(F * G);
    return new ExtendedPoint(X3, Y3, Z3, T3);
  }

  // Fast algo for adding 2 Extended Points when curve's a=-1.
  // http://hyperelliptic.org/EFD/g1p/auto-twisted-extended-1.html#addition-add-2008-hwcd-4
  // Cost: 8M + 8add + 2*2.
  add(other: ExtendedPoint): ExtendedPoint {
    const X1 = this.x;
    const Y1 = this.y;
    const Z1 = this.z;
    const T1 = this.t;
    const X2 = other.x;
    const Y2 = other.y;
    const Z2 = other.z;
    const T2 = other.t;
    const A = mod((Y1 - X1) * (Y2 + X2));
    const B = mod((Y1 + X1) * (Y2 - X2));
    const F = mod(B - A);
    if (F === 0n) {
      // Same point.
      return this.double();
    }
    const C = mod(Z1 * 2n * T2);
    const D = mod(T1 * 2n * Z2);
    const E = mod(D + C);
    const G = mod(B + A);
    const H = mod(D - C);
    const X3 = mod(E * F);
    const Y3 = mod(G * H);
    const T3 = mod(E * H);
    const Z3 = mod(F * G);
    return new ExtendedPoint(X3, Y3, Z3, T3);
  }

  subtract(other: ExtendedPoint): ExtendedPoint {
    return this.add(other.negate());
  }

  // Non-constant-time multiplication. Uses double-and-add algorithm.
  // It's faster, but should only be used when you don't care about
  // an exposed private key e.g. sig verification.
  multiplyUnsafe(scalar: bigint): ExtendedPoint {
    if (!isValidScalar(scalar)) throw new TypeError('Point#multiply: expected number or bigint');
    let n = mod(BigInt(scalar), CURVE.n);
    if (n === 1n) return this;
    let p = ExtendedPoint.ZERO;
    let d: ExtendedPoint = this;
    while (n > 0n) {
      if (n & 1n) p = p.add(d);
      d = d.double();
      n >>= 1n;
    }
    return p;
  }

  private precomputeWindow(W: number): ExtendedPoint[] {
    const windows = 256 / W + 1;
    let points: ExtendedPoint[] = [];
    let p: ExtendedPoint = this;
    let base = p;
    for (let window = 0; window < windows; window++) {
      base = p;
      points.push(base);
      for (let i = 1; i < 2 ** (W - 1); i++) {
        base = base.add(p);
        points.push(base);
      }
      p = base.double();
    }
    return points;
  }

  private wNAF(n: bigint, affinePoint?: Point): [ExtendedPoint, ExtendedPoint] {
    if (!affinePoint && this.equals(ExtendedPoint.BASE)) affinePoint = Point.BASE;
    const W = (affinePoint && affinePoint._WINDOW_SIZE) || 1;
    if (256 % W) {
      throw new Error('Point#wNAF: Invalid precomputation window, must be power of 2');
    }

    let precomputes = affinePoint && pointPrecomputes.get(affinePoint);
    if (!precomputes) {
      precomputes = this.precomputeWindow(W);
      if (affinePoint && W !== 1) {
        precomputes = ExtendedPoint.normalizeZ(precomputes);
        pointPrecomputes.set(affinePoint, precomputes);
      }
    }

    let p = ExtendedPoint.ZERO;
    let f = ExtendedPoint.ZERO;

    const windows = 256 / W + 1;
    const windowSize = 2 ** (W - 1);
    const mask = BigInt(2 ** W - 1); // Create mask with W ones: 0b1111 for W=4 etc.
    const maxNumber = 2 ** W;
    const shiftBy = BigInt(W);

    for (let window = 0; window < windows; window++) {
      const offset = window * windowSize;
      // Extract W bits.
      let wbits = Number(n & mask);

      // Shift number by W bits.
      n >>= shiftBy;

      // If the bits are bigger than max size, we'll split those.
      // +224 => 256 - 32
      if (wbits > windowSize) {
        wbits -= maxNumber;
        n += 1n;
      }

      // Check if we're onto Zero point.
      // Add random point inside current window to f.
      if (wbits === 0) {
        f = f.add(window % 2 ? precomputes[offset].negate() : precomputes[offset]);
      } else {
        const cached = precomputes[offset + Math.abs(wbits) - 1];
        p = p.add(wbits < 0 ? cached.negate() : cached);
      }
    }
    return [p, f];
  }

  // Constant time multiplication.
  // Uses wNAF method. Windowed method may be 10% faster,
  // but takes 2x longer to generate and consumes 2x memory.
  multiply(scalar: number | bigint, affinePoint?: Point): ExtendedPoint {
    if (!isValidScalar(scalar)) throw new TypeError('Point#multiply: expected number or bigint');
    const n = mod(BigInt(scalar), CURVE.n);
    return ExtendedPoint.normalizeZ(this.wNAF(n, affinePoint))[0];
  }

  // Converts Extended point to default (x, y) coordinates.
  // Can accept precomputed Z^-1 - for example, from invertBatch.
  toAffine(invZ: bigint = invert(this.z)): Point {
    const x = mod(this.x * invZ);
    const y = mod(this.y * invZ);
    return new Point(x, y);
  }
}

// Stores precomputed values for points.
const pointPrecomputes = new WeakMap<Point, ExtendedPoint[]>();

// Default Point works in default aka affine coordinates: (x, y)
class Point {
  // Base point aka generator
  // public_key = Point.BASE * private_key
  static BASE: Point = new Point(CURVE.Gx, CURVE.Gy);
  // Identity point aka point at infinity
  // point = point + zero_point
  static ZERO: Point = new Point(0n, 1n);
  // We calculate precomputes for elliptic curve point multiplication
  // using windowed method. This specifies window size and
  // stores precomputed values. Usually only base point would be precomputed.
  _WINDOW_SIZE?: number;

  constructor(public x: bigint, public y: bigint) {}

  // "Private method", don't use it directly.
  _setWindowSize(windowSize: number) {
    this._WINDOW_SIZE = windowSize;
    pointPrecomputes.delete(this);
  }
  // Converts hash string or Uint8Array to Point.
  // Uses algo from RFC8032 5.1.3.
  static fromHex(hash: Hex) {
    const { d, P } = CURVE;
    const bytes = hash instanceof Uint8Array ? hash : hexToBytes(hash);
    const len = bytes.length - 1;
    const normedLast = bytes[len] & ~0x80;
    const isLastByteOdd = (bytes[len] & 0x80) !== 0;
    const normed = Uint8Array.from(Array.from(bytes.slice(0, len)).concat(normedLast));
    const y = bytesToNumberLE(normed);
    if (y >= P) {
      throw new Error('Point#fromHex expects hex <= Fp');
    }
    const sqrY = y * y;
    const sqrX = mod((sqrY - 1n) * invert(d * sqrY + 1n));
    let x = sqrtMod(sqrX);
    if (mod(x * x - sqrX) !== 0n) {
      x = mod(x * SQRT_M1);
    }
    const isXOdd = (x & 1n) === 1n;
    if (isLastByteOdd !== isXOdd) {
      x = mod(-x);
    }
    return new Point(x, y);
  }

  static async fromPrivateKey(privateKey: PrivKey) {
    const privBytes = await utils.sha512(normalizePrivateKey(privateKey));
    return Point.BASE.multiply(encodePrivate(privBytes));
  }

  /**
   * Converts point to compressed representation of its Y.
   * ECDSA uses `04${x}${y}` to represent long form and
   * `02${x}` / `03${x}` to represent short form,
   * where leading bit signifies positive or negative Y.
   * EDDSA (ed25519) uses short form.
   */
  toRawBytes(): Uint8Array {
    const hex = numberToHex(this.y);
    const u8 = new Uint8Array(B32);
    for (let i = hex.length - 2, j = 0; j < B32 && i >= 0; i -= 2, j++) {
      u8[j] = parseInt(hex[i] + hex[i + 1], 16);
    }
    const mask = this.x & 1n ? 0x80 : 0;
    u8[B32 - 1] |= mask;
    return u8;
  }

  // Same as toRawBytes, but returns string.
  toHex(): string {
    return bytesToHex(this.toRawBytes());
  }

  // Converts to Montgomery; aka x coordinate of curve25519.
  // We don't have fromX25519, because we don't know sign!
  toX25519() {
    // curve25519 is birationally equivalent to ed25519
    // x, y: ed25519 coordinates
    // u, v: x25519 coordinates
    // u = (1 + y) / (1 - y)
    // See https://blog.filippo.io/using-ed25519-keys-for-encryption
    return mod((1n + this.y) * invert(1n - this.y));
  }

  equals(other: Point): boolean {
    return this.x === other.x && this.y === other.y;
  }

  negate() {
    return new Point(mod(-this.x), this.y);
  }

  add(other: Point) {
    return ExtendedPoint.fromAffine(this).add(ExtendedPoint.fromAffine(other)).toAffine();
  }

  subtract(other: Point) {
    return this.add(other.negate());
  }

  // Constant time multiplication.
  multiply(scalar: number | bigint): Point {
    return ExtendedPoint.fromAffine(this).multiply(scalar, this).toAffine();
  }
}

class Signature {
  constructor(public r: Point, public s: bigint) {}

  static fromHex(hex: Hex) {
    hex = ensureBytes(hex);
    const r = Point.fromHex(hex.slice(0, 32));
    const s = bytesToNumberLE(hex.slice(32));
    if (s >= CURVE.n) {
      throw new Error('Signature#fromHex expects s <= CURVE.n');
    }
    return new Signature(r, s);
  }

  toRawBytes() {
    const numberBytes = hexToBytes(numberToHex(this.s)).reverse();
    const sBytes = new Uint8Array(B32);
    sBytes.set(numberBytes);
    const res = new Uint8Array(B32 * 2);
    res.set(this.r.toRawBytes());
    res.set(sBytes, 32);
    return res;
    // return concatTypedArrays(this.r.toRawBytes(), sBytes);
  }

  toHex() {
    return bytesToHex(this.toRawBytes());
  }
}

export { ExtendedPoint, Point, Signature, Signature as SignResult };

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 1) return arrays[0];
  const length = arrays.reduce((a, arr) => a + arr.length, 0);
  const result = new Uint8Array(length);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const arr = arrays[i];
    result.set(arr, pad);
    pad += arr.length;
  }
  return result;
}

// Convert between types
// ---------------------
function bytesToHex(uint8a: Uint8Array): string {
  // pre-caching chars could speed this up 6x.
  let hex = '';
  for (let i = 0; i < uint8a.length; i++) {
    hex += uint8a[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2) throw new Error('Expected valid hex');
  const array = new Uint8Array(hex.length / 2);
  for (let i = 0; i < array.length; i++) {
    const j = i * 2;
    array[i] = Number.parseInt(hex.slice(j, j + 2), 16);
  }
  return array;
}

function numberToHex(num: number | bigint): string {
  const hex = num.toString(16);
  return hex.length & 1 ? `0${hex}` : hex;
}

function numberToBytesPadded(num: bigint, length: number = B32) {
  const hex = numberToHex(num).padStart(length * 2, '0');
  return hexToBytes(hex).reverse();
}

function edIsNegative(num: bigint) {
  const hex = numberToHex(mod(num));
  const byte = Number.parseInt(hex.slice(hex.length - 2, hex.length), 16);
  return Boolean(byte & 1);
}

function isValidScalar(num: number | bigint): boolean {
  if (typeof num === 'bigint' && num > 0n) return true;
  if (typeof num === 'number' && num > 0 && Number.isSafeInteger(num)) return true;
  return false;
}

// Little Endian
function bytesToNumberLE(uint8a: Uint8Array): bigint {
  let value = 0n;
  for (let i = 0; i < uint8a.length; i++) {
    value += BigInt(uint8a[i]) << (8n * BigInt(i));
  }
  return value;
}

function load8(input: Uint8Array, padding = 0) {
  return (
    BigInt(input[0 + padding]) |
    (BigInt(input[1 + padding]) << 8n) |
    (BigInt(input[2 + padding]) << 16n) |
    (BigInt(input[3 + padding]) << 24n) |
    (BigInt(input[4 + padding]) << 32n) |
    (BigInt(input[5 + padding]) << 40n) |
    (BigInt(input[6 + padding]) << 48n) |
    (BigInt(input[7 + padding]) << 56n)
  );
}
const low51bitMask = (1n << 51n) - 1n;
// CUSTOM array to number.
function bytesToNumberRst(bytes: Uint8Array) {
  const octet1 = load8(bytes, 0) & low51bitMask;
  const octet2 = (load8(bytes, 6) >> 3n) & low51bitMask;
  const octet3 = (load8(bytes, 12) >> 6n) & low51bitMask;
  const octet4 = (load8(bytes, 19) >> 1n) & low51bitMask;
  const octet5 = (load8(bytes, 24) >> 12n) & low51bitMask;
  return mod(octet1 + (octet2 << 51n) + (octet3 << 102n) + (octet4 << 153n) + (octet5 << 204n));
}
// -------------------------

function mod(a: bigint, b: bigint = CURVE.P) {
  const res = a % b;
  return res >= 0n ? res : b + res;
}

// Eucledian GCD
// https://brilliant.org/wiki/extended-euclidean-algorithm/
function egcd(a: bigint, b: bigint) {
  let [x, y, u, v] = [0n, 1n, 1n, 0n];
  while (a !== 0n) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    [b, a] = [a, r];
    [x, y] = [u, v];
    [u, v] = [m, n];
  }
  const gcd = b;
  return [gcd, x, y];
}

function invert(number: bigint, modulo: bigint = CURVE.P) {
  if (number === 0n || modulo <= 0n) {
    throw new Error('invert: expected positive integers');
  }
  const [gcd, x] = egcd(mod(number, modulo), modulo);
  if (gcd !== 1n) {
    throw new Error('invert: does not exist');
  }
  return mod(x, modulo);
}

function invertBatch(nums: bigint[], n: bigint = CURVE.P): bigint[] {
  const len = nums.length;
  const scratch = new Array(len);
  let acc = 1n;
  for (let i = 0; i < len; i++) {
    if (nums[i] === 0n) continue;
    scratch[i] = acc;
    acc = mod(acc * nums[i], n);
  }
  acc = invert(acc, n);
  for (let i = len - 1; i >= 0; i--) {
    if (nums[i] === 0n) continue;
    let tmp = mod(acc * nums[i], n);
    nums[i] = mod(acc * scratch[i], n);
    acc = tmp;
  }
  return nums;
}

// Attempt to compute `sqrt(1/number)` in constant time.
function invertSqrt(number: bigint) {
  return sqrtRatio(1n, number);
}

// Does x ^ (2 ^ power). E.g. 30 ^ (2 ^ 4)
function pow2(x: bigint, power: bigint): bigint {
  const { P } = CURVE;
  let res = x;
  while (power-- > 0n) {
    res *= res;
    res %= P;
  }
  return res;
}

// Used to calculate y - the square root of y^2.
// Exponentiates it to very big number.
// We are unwrapping the loop because it's 2x faster.
// (2n**252n-3n).toString(2) would produce bits [250x 1, 0, 1]
// We are multiplying it bit-by-bit
function chunks250(x: bigint): bigint {
  const { P } = CURVE;
  const xx = (x * x) % P;
  const b2 = (xx * x) % P; // x^3, 11
  const b4 = (pow2(b2, 2n) * b2) % P; // 1111
  const b5 = (pow2(b4, 1n) * x) % P;
  const b10 = (pow2(b5, 5n) * b5) % P;
  const b20 = (pow2(b10, 10n) * b10) % P;
  const b40 = (pow2(b20, 20n) * b20) % P;
  const b80 = (pow2(b40, 40n) * b40) % P;
  const b160 = (pow2(b80, 80n) * b80) % P;
  const b240 = (pow2(b160, 80n) * b80) % P;
  const b250 = (pow2(b240, 10n) * b10) % P;
  return b250;
}

// Power to x^(2^252-3) aka p/8
function pow_2_252_3(x: bigint): bigint {
  return (pow2(chunks250(x), 2n) * x) % CURVE.P;
}
// Power to x^(2^252-2) aka (p+3)/8
function sqrtMod(x: bigint): bigint {
  return (pow_2_252_3(x) * x) % CURVE.P;
}

function sqrtRatio(t: bigint, v: bigint) {
  // Using the same trick as in ed25519 decoding, we merge the
  // inversion, the square root, and the square test as follows.
  //
  // To compute sqrt(α), we can compute β = α^((p+3)/8).
  // Then β^2 = ±α, so multiplying β by sqrt(-1) if necessary
  // gives sqrt(α).
  //
  // To compute 1/sqrt(α), we observe that
  //    1/β = α^(p-1 - (p+3)/8) = α^((7p-11)/8)
  //                            = α^3 * (α^7)^((p-5)/8).
  //
  // We can therefore compute sqrt(u/v) = sqrt(u)/sqrt(v)
  // by first computing
  //    r = u^((p+3)/8) v^(p-1-(p+3)/8)
  //      = u u^((p-5)/8) v^3 (v^7)^((p-5)/8)
  //      = (uv^3) (uv^7)^((p-5)/8).
  //
  // If v is nonzero and u/v is square, then r^2 = ±u/v,
  //                                     so vr^2 = ±u.
  // If vr^2 =  u, then sqrt(u/v) = r.
  // If vr^2 = -u, then sqrt(u/v) = r*sqrt(-1).
  //
  // If v is zero, r is also zero.
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let r = mod(pow_2_252_3(t * v7) * t * v3);
  const check = mod(r * r * v);
  const i = SQRT_M1;
  const correctSignSqrt = check === t;
  const flippedSignSqrt = check === mod(-t);
  const flippedSignSqrtI = check === mod(mod(-t) * i);
  const rPrime = mod(SQRT_M1 * r);
  r = flippedSignSqrt || flippedSignSqrtI ? rPrime : r;
  if (edIsNegative(r)) r = mod(-r);
  const isNotZeroSquare = correctSignSqrt || flippedSignSqrt;
  return { isNotZeroSquare, value: mod(r) };
}

// Math end

async function sha512ToNumberLE(...args: Uint8Array[]): Promise<bigint> {
  const messageArray = concatBytes(...args);
  const hash = await utils.sha512(messageArray);
  const value = bytesToNumberLE(hash);
  return mod(value, CURVE.n);
}

function keyPrefix(privateBytes: Uint8Array) {
  return privateBytes.slice(B32);
}

function encodePrivate(privateBytes: Uint8Array): bigint {
  const last = B32 - 1;
  const head = privateBytes.slice(0, B32);
  head[0] &= 248;
  head[last] &= 127;
  head[last] |= 64;

  return bytesToNumberLE(head);
}

function equalBytes(b1: Uint8Array, b2: Uint8Array) {
  if (b1.length !== b2.length) {
    return false;
  }
  for (let i = 0; i < b1.length; i++) {
    if (b1[i] !== b2[i]) {
      return false;
    }
  }
  return true;
}

function ensureBytes(hash: Hex): Uint8Array {
  return hash instanceof Uint8Array ? hash : hexToBytes(hash);
}

function normalizePrivateKey(privateKey: PrivKey): Uint8Array {
  if (privateKey instanceof Uint8Array) {
    if (privateKey.length !== 32) throw new TypeError('Expected 32 bytes of private key');
    return privateKey;
  }
  if (typeof privateKey === 'string') {
    if (privateKey.length !== 64) throw new TypeError('Expected 32 bytes of private key');
    return hexToBytes(privateKey);
  }
  if (isValidScalar(privateKey)) {
    return hexToBytes(
      BigInt(privateKey)
        .toString(16)
        .padStart(B32 * 2, '0')
    );
  }
  throw new TypeError('Invalid private key');
}

export function getPublicKey(privateKey: Uint8Array | bigint | number): Promise<Uint8Array>;
export function getPublicKey(privateKey: string): Promise<string>;
export async function getPublicKey(privateKey: PrivKey) {
  const key = await Point.fromPrivateKey(privateKey);
  return typeof privateKey === 'string' ? key.toHex() : key.toRawBytes();
}

export function sign(hash: Uint8Array, privateKey: Hex): Promise<Uint8Array>;
export function sign(hash: string, privateKey: Hex): Promise<string>;
export async function sign(hash: Hex, privateKey: Hex) {
  const privBytes = await utils.sha512(normalizePrivateKey(privateKey));
  const p = encodePrivate(privBytes);
  const P = Point.BASE.multiply(p);
  const msg = ensureBytes(hash);
  const r = await sha512ToNumberLE(keyPrefix(privBytes), msg);
  const R = Point.BASE.multiply(r);
  const h = await sha512ToNumberLE(R.toRawBytes(), P.toRawBytes(), msg);
  const S = mod(r + h * p, CURVE.n);
  const sig = new Signature(R, S);
  return typeof hash === 'string' ? sig.toHex() : sig.toRawBytes();
}

export async function verify(signature: SigType, hash: Hex, publicKey: PubKey): Promise<boolean> {
  hash = ensureBytes(hash);
  if (!(publicKey instanceof Point)) publicKey = Point.fromHex(publicKey);
  if (!(signature instanceof Signature)) signature = Signature.fromHex(signature);
  const hs = await sha512ToNumberLE(signature.r.toRawBytes(), publicKey.toRawBytes(), hash);
  const Ph = ExtendedPoint.fromAffine(publicKey).multiplyUnsafe(hs);
  const Gs = ExtendedPoint.BASE.multiply(signature.s);
  const RPh = ExtendedPoint.fromAffine(signature.r).add(Ph);
  return RPh.subtract(Gs).multiplyUnsafe(8n).equals(ExtendedPoint.ZERO);
}

// Enable precomputes. Slows down first publicKey computation by 20ms.
Point.BASE._setWindowSize(8);

export const utils = {
  // The 8-torsion subgroup ℰ8.
  // Those are "buggy" points, if you multiply them by 8, you'll receive Point.ZERO.
  // Ported from curve25519-dalek.
  TORSION_SUBGROUP: [
    '0100000000000000000000000000000000000000000000000000000000000000',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
    '0000000000000000000000000000000000000000000000000000000000000080',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
    'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
    '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
    '0000000000000000000000000000000000000000000000000000000000000000',
    'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
  ],
  randomPrivateKey: (bytesLength: number = 32): Uint8Array => {
    // @ts-ignore
    if (typeof window == 'object' && 'crypto' in window) {
      // @ts-ignore
      return window.crypto.getRandomValues(new Uint8Array(bytesLength));
      // @ts-ignore
    } else if (typeof process === 'object' && 'node' in process.versions) {
      // @ts-ignore
      const { randomBytes } = require('crypto');
      return new Uint8Array(randomBytes(bytesLength).buffer);
    } else {
      throw new Error("The environment doesn't have randomBytes function");
    }
  },
  sha512: async (message: Uint8Array): Promise<Uint8Array> => {
    // @ts-ignore
    if (typeof window == 'object' && 'crypto' in window) {
      // @ts-ignore
      const buffer = await window.crypto.subtle.digest('SHA-512', message.buffer);
      // @ts-ignore
      return new Uint8Array(buffer);
      // @ts-ignore
    } else if (typeof process === 'object' && 'node' in process.versions) {
      // @ts-ignore
      const { createHash } = require('crypto');
      const hash = createHash('sha512');
      hash.update(message);
      return Uint8Array.from(hash.digest());
    } else {
      throw new Error("The environment doesn't have sha512 function");
    }
  },
  precompute(windowSize = 8, point = Point.BASE): Point {
    const cached = point.equals(Point.BASE) ? point : new Point(point.x, point.y);
    cached._setWindowSize(windowSize);
    cached.multiply(1n);
    return cached;
  },
};
