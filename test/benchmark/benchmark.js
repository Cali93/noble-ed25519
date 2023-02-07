const { run, mark, utils } = require('micro-bmark');
const { sha512 } = require('@noble/hashes/sha512');
let ed = require('../../lib');

run(async () => {
  // warm-up
  await mark(() => {
    ed.utils.precompute();
  });
  ed.utils.sha512Sync = (...m) => sha512(ed.utils.concatBytes(...m));

  utils.logMem();
  console.log();

  function to64Bytes(numOrStr) {
    let hex = typeof numOrStr === 'string' ? numOrStr : numOrStr.toString(16);
    return ed.utils.hexToBytes(hex.padStart(64, '0'));
  }

  // const priv1bit = to64Bytes(2n);
  const smallPrivs = [2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n].map(a => to64Bytes(a));
  const priv = to64Bytes(0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60n);
  const msg = to64Bytes('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');

  let pubHex, sigHex, i = 0;
  await mark('getPublicKey 1 bit', 6000, () => {
    pubHex = ed.getPublicKey(smallPrivs[i++ % smallPrivs.length]);
  });

  await mark('getPublicKey(utils.randomPrivateKey())', 6000, () => {
    pubHex = ed.getPublicKey(ed.utils.randomPrivateKey());
  });

  await mark('sign', 4000, () => {
    sigHex = ed.sign(msg, priv);
  });
  await mark('verify', 800, () => {
    return ed.verify(sigHex, msg, pubHex);
  });
  await mark('Point.fromHex decompression', 13000, () => {
    ed.ExtendedPoint.fromHex(pubHex);
  });


  console.log();
  await mark('getPublicKeyAsync', 6000, () => ed.getPublicKeyAsync(ed.utils.randomPrivateKey()));
  await mark('signAsync', 4000, () => ed.signAsync(msg, priv));
  await mark('verifyAsync', 800, () => ed.verifyAsync(sigHex, msg, pubHex));

  utils.logMem();
});
