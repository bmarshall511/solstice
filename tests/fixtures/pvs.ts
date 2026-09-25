// Synthetic SunPower PVS6 varserver answers for tests/server/pvs.test.ts, plus a throwaway self-signed certificate made
// at run time (so no private key is ever committed). Serial numbers are obviously fake (TEST-INV-nn); the field names
// follow SunStrong's pypvs LocalAPI doc (sn, pMppt1Kw, vMppt1V, tHtsnkDegc), values are strings as the PVS sends them.
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';

/** Per-inverter object form: { "/sys/devices/inverter/<i>": { sn, pMppt1Kw, … } }. */
export const PVS_INVERTERS_OBJ = {
  '/sys/devices/inverter/0': { sn: 'TEST-INV-01', prodMdlNm: 'AC_Module_Type_H', pMppt1Kw: '0.2104', vMppt1V: '33.12', iMppt1A: '6.35', tHtsnkDegc: '41', p3phsumKw: '0.2031' },
  '/sys/devices/inverter/1': { sn: 'TEST-INV-02', prodMdlNm: 'AC_Module_Type_H', pMppt1Kw: '0.1987', vMppt1V: '32.80', iMppt1A: '6.06', tHtsnkDegc: '43.5', p3phsumKw: '0.1920' },
  '/sys/devices/inverter/2': { sn: 'TEST-INV-03', prodMdlNm: 'AC_Module_Type_H', pMppt1Kw: '0.0000', vMppt1V: '0', iMppt1A: '0', tHtsnkDegc: '', p3phsumKw: '0' },
};

/** The same readings in the flat form: { "/sys/devices/inverter/<i>/<field>": value }. */
export const PVS_INVERTERS_FLAT = Object.fromEntries(Object.entries(PVS_INVERTERS_OBJ).flatMap(([path, o]) =>
  Object.entries(o).map(([k, v]) => [`${path}/${k}`, v])));

/** And in the { count, values: [{ name, value }] } form. */
export const PVS_INVERTERS_VALUES = { count: Object.keys(PVS_INVERTERS_FLAT).length, values: Object.entries(PVS_INVERTERS_FLAT).map(([name, value]) => ({ name, value })) };

/** What the relay should post for the fixture above. */
export const PVS_EXPECTED = [
  { sn: 'TEST-INV-01', kw: 0.2104, v: 33.12, tempC: 41 },
  { sn: 'TEST-INV-02', kw: 0.1987, v: 32.8, tempC: 43.5 },
  { sn: 'TEST-INV-03', kw: 0, v: 0, tempC: null },
];

/* ---- a minimal DER encoder, enough for one self-signed X.509 v3 certificate (ECDSA P-256, SHA-256) ---- */
const len = (n: number) => n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const oid = (...bytes: number[]) => tlv(0x06, Buffer.from(bytes));
const ECDSA_SHA256 = seq(oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02));   // 1.2.840.10045.4.3.2
const commonName = (cn: string) => seq(tlv(0x31, seq(oid(0x55, 0x04, 0x03), tlv(0x0c, Buffer.from(cn)))));   // 2.5.4.3
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().slice(2, 19).replace(/[-:T]/g, '') + 'Z'));

/** A fresh self-signed certificate like the PVS's (CN=pvs.local), its key and its SHA-256 fingerprint. */
export function selfSignedCert(cn = 'pvs.local') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),            // version v3
    tlv(0x02, Buffer.from([0x01, 0x02, 0x03])),         // certificate serial
    ECDSA_SHA256, commonName(cn),
    seq(utcTime(new Date(Date.now() - 864e5)), utcTime(new Date(Date.now() + 30 * 864e5))),   // valid from yesterday for 30 days
    commonName(cn), publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, sha256: new X509Certificate(cert).fingerprint256 };
}
