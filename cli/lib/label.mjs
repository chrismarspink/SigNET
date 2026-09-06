// Signet 라벨 v2 — 발급·정규화·서명·검증.
// 정규화는 데모(index.html)의 canonicalizeLabel과 바이트 단위로 동일해야 한다.
// test/conformance.mjs가 두 구현의 일치를 강제한다.
import { webcrypto as wc } from 'node:crypto';

const subtle = wc.subtle;
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const te = new TextEncoder();

export const b64 = b => Buffer.from(b).toString('base64');
export const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
export async function sha256Hex(bytes) {
  const d = await subtle.digest('SHA-256', bytes);
  return Buffer.from(d).toString('hex');
}

/* ── 정규화 (데모 코어와 동일) ── */
export function canonicalizeLabel(l) {
  const v = x => Array.isArray(x) ? x.slice().sort().join(',') : (x == null ? '' : String(x));
  const b = l.basis || {}, is = l.issuer || {}, rv = l.revoker || {},
        c = l.content || {}, ln = l.lineage || {}, rt = l.releasableTo || {};
  return [
    l.schema, l.id, l.grade,
    b.law, b.article, b.clause, b.registryId,
    is.org, is.unit, is.keyId,
    l.approver, l.actionId, l.issuedAt, l.validUntil,
    rv.type, rv.ref,
    v(l.handling), l.granularity, l.attach, l.trust,
    rt.scope, v(rt.orgs), v(rt.conditions),
    c.hash, v((c.portions || []).map(p => `${p.range}:${p.grade}:${p.hash}`)),
    v(ln.parents), ln.op,
    l.releaseId, l.verifyUrl,
  ].map(v).join('\n');
}

/* ── 해시 대상 표기 ──
   실파일은 재저장만으로 바이트가 바뀐다. 무엇을 해시했는지 검증 측이 알아야 하므로
   content.hash에 대상을 접두어로 싣는다: "sha256/payload:<hex>".
   이 값은 정규화 대상(c.hash)에 포함되므로 별도 스키마 변경 없이 서명으로 보호된다. */
export const HASH_TARGETS = ['whole', 'payload', 'text'];
export const packHash = (target, hex) => `sha256/${target}:${hex}`;
export function unpackHash(v) {
  const m = /^sha256\/([a-z]+):([0-9a-f]{64})$/.exec(String(v || ''));
  return m ? { target: m[1], hex: m[2] } : { target: 'whole', hex: String(v || '') };
}

/* ── 키·간이 인증서 ── */
export async function generateOrgKey(orgId, unit) {
  const kp = await subtle.generateKey(EC, true, ['sign', 'verify']);
  const pubJwk = await subtle.exportKey('jwk', kp.publicKey);
  const privJwk = await subtle.exportKey('jwk', kp.privateKey);
  return { org: orgId, unit: unit || '', keyId: `${orgId}-sign-2026`, pubJwk, privJwk };
}
const certBytes = (subject, jwk) => te.encode(subject + '\n' + JSON.stringify(jwk));

export async function issueCert(rootKey, orgKey) {
  const priv = await subtle.importKey('jwk', rootKey.privJwk, EC, false, ['sign']);
  const sig = await subtle.sign(SIG, priv, certBytes(orgKey.org, orgKey.pubJwk));
  return { subject: orgKey.org, publicKeyJwk: orgKey.pubJwk, issuer: rootKey.org, signature: b64(sig) };
}
export async function verifyCert(rootKey, cert) {
  const pub = await subtle.importKey('jwk', rootKey.pubJwk, EC, false, ['verify']);
  return subtle.verify(SIG, pub, unb64(cert.signature), certBytes(cert.subject, cert.publicKeyJwk));
}

/* ── 라벨 발급·검증 ── */
const CRITERIA = {
  PRIV:  { law: '정보공개법', article: '9', clause: '6', grade: 'S' },
  BIZ:   { law: '정보공개법', article: '9', clause: '7', grade: 'S' },
  AUDIT: { law: '정보공개법', article: '9', clause: '5', grade: 'S' },
  SAFE:  { law: '정보공개법', article: '9', clause: '3', grade: 'S' },
  LAW:   { law: '정보공개법', article: '9', clause: '1', grade: 'C' },
  SEC:   { law: '정보공개법', article: '9', clause: '2', grade: 'C' },
  TRIAL: { law: '정보공개법', article: '9', clause: '4', grade: 'C' },
  OPEN:  { law: '-', article: '-', clause: '-', grade: 'O' },
};
export { CRITERIA };

let seq = 0;
export async function buildLabel(opts) {
  const c = CRITERIA[opts.basisId] || CRITERIA.OPEN;
  seq++;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const label = {
    schema: 'signet/label/2',
    id: opts.id || `LBL-${stamp}-${String(seq).padStart(4, '0')}`,
    grade: opts.grade,
    basis: { law: c.law, article: c.article, clause: c.clause, registryId: opts.basisId },
    issuer: { org: opts.key.org, unit: opts.key.unit, keyId: opts.key.keyId },
    approver: opts.approver,
    actionId: opts.actionId || `ACT-${stamp}-${String(seq).padStart(4, '0')}`,
    issuedAt: opts.issuedAt || new Date().toISOString(),
    validUntil: opts.validUntil ?? new Date(Date.now() + 730 * 86400000).toISOString(),
    revoker: { type: 'owner', ref: opts.key.org },
    handling: opts.handling || [],
    granularity: opts.granularity || 'object',
    attach: opts.attach || 'embedded',
    trust: 'internal',
    releasableTo: {
      scope: opts.scope || 'internal',
      orgs: opts.orgs || [],
      conditions: opts.conditions || [],
    },
    content: { hash: packHash(opts.hashTarget, opts.hashHex), portions: [] },
    lineage: { parents: [], op: null },
    releaseId: null, verifyUrl: null,
    signature: null,
  };
  const priv = await subtle.importKey('jwk', opts.key.privJwk, EC, false, ['sign']);
  const sig = await subtle.sign(SIG, priv, te.encode(canonicalizeLabel(label)));
  label.signature = { alg: 'ECDSA-P256', over: 'canonical(core)', value: b64(sig) };
  return label;
}

export async function verifyLabelSignature(label, cert) {
  const pub = await subtle.importKey('jwk', cert.publicKeyJwk, EC, false, ['verify']);
  return subtle.verify(SIG, pub, unb64(label.signature.value), te.encode(canonicalizeLabel(label)));
}
