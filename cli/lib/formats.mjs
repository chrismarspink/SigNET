// 포맷별 부착·추출·해시 대상. 데모의 §2 부착 축을 실파일에 대응시킨다.
import fs from 'node:fs';
import path from 'node:path';
import { readZip, entryData, upsertEntry } from './zipfile.mjs';
import { attachXmp, extractXmp } from './pdf.mjs';
import { sha256Hex, packHash } from './label.mjs';

export const FORMATS = {
  hwpx: { kind: 'zip', part: 'META-INF/signet-label.xml', payload: /^Contents\/.*\.xml$/i, text: true },
  docx: { kind: 'zip', part: 'customXml/signetLabel.xml', payload: /^word\/document\.xml$/i, text: true },
  zip:  { kind: 'zip', part: 'signet/label.xml',           payload: null,                    text: false },
  pdf:  { kind: 'pdf', part: 'XMP signet:label',           payload: 'eof-prefix',            text: false },
  hwp:  { kind: 'cfb', part: 'CFB 스트림 Signet/Label',    payload: null,                    text: false },
};

export const detectFormat = p => {
  const e = path.extname(p).toLowerCase().replace('.', '');
  return FORMATS[e] ? e : null;
};

export function capabilities(fmt) {
  const f = FORMATS[fmt];
  return {
    embed: f.kind === 'zip' || f.kind === 'pdf',        // 파일 내부 부착 가능 여부
    payload: !!f.payload,                                // 본문 파트 단위 해시 가능 여부
    text: !!f.text,                                      // 본문 텍스트 해시 가능 여부
    sidecar: true,                                       // 사이드카는 모든 포맷에서 가능
    note: f.kind === 'cfb' ? 'CFB 쓰기 미구현 — 사이드카로만 측정 (실측 계획서 R-1)' : '',
  };
}

/* ── 라벨 XML 직렬화·파싱 (스키마가 고정이므로 대상 지향 파서를 쓴다) ── */
const xe = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xu = v => String(v ?? '').replace(/&quot;/g, '"').replace(/&gt;/g, '>')
  .replace(/&lt;/g, '<').replace(/&amp;/g, '&');

export function labelToXml(l) {
  const L = [];
  const el = (n, v) => L.push(`  <signet:${n}>${xe(v)}</signet:${n}>`);
  el('grade', l.grade);
  L.push(`  <signet:basis law="${xe(l.basis.law)}" article="${xe(l.basis.article)}" clause="${xe(l.basis.clause)}" registryId="${xe(l.basis.registryId)}"/>`);
  L.push(`  <signet:issuer org="${xe(l.issuer.org)}" unit="${xe(l.issuer.unit)}" keyId="${xe(l.issuer.keyId)}"/>`);
  el('approver', l.approver); el('actionId', l.actionId);
  el('issuedAt', l.issuedAt); el('validUntil', l.validUntil);
  L.push(`  <signet:revoker type="${xe(l.revoker.type)}" ref="${xe(l.revoker.ref)}"/>`);
  L.push('  <signet:handling>', ...(l.handling || []).map(h => `    <signet:code>${xe(h)}</signet:code>`), '  </signet:handling>');
  el('granularity', l.granularity); el('attach', l.attach); el('trust', l.trust);
  L.push(`  <signet:releasableTo scope="${xe(l.releasableTo.scope)}">`,
    ...(l.releasableTo.orgs || []).map(o => `    <signet:org>${xe(o)}</signet:org>`),
    ...(l.releasableTo.conditions || []).map(c => `    <signet:condition>${xe(c)}</signet:condition>`),
    '  </signet:releasableTo>');
  L.push(`  <signet:content hash="${xe(l.content.hash)}"/>`);
  L.push(`  <signet:lineage op="${xe(l.lineage.op)}">`,
    ...(l.lineage.parents || []).map(p => `    <signet:parent>${xe(p)}</signet:parent>`), '  </signet:lineage>');
  L.push(`  <signet:signature alg="${xe(l.signature.alg)}" over="${xe(l.signature.over)}">${xe(l.signature.value)}</signet:signature>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<signet:label xmlns:signet="urn:signet:label:2" schema="${xe(l.schema)}" id="${xe(l.id)}">\n${L.join('\n')}\n</signet:label>\n`;
}

export function xmlToLabel(xml) {
  const txt = n => { const m = new RegExp(`<signet:${n}>([\\s\\S]*?)</signet:${n}>`).exec(xml); return m ? xu(m[1]) : ''; };
  const at = (n, a) => { const m = new RegExp(`<signet:${n}\\b[^>]*\\b${a}="([^"]*)"`).exec(xml); return m ? xu(m[1]) : ''; };
  const many = (parent, child) => {
    const b = new RegExp(`<signet:${parent}\\b[^>]*>([\\s\\S]*?)</signet:${parent}>`).exec(xml);
    if (!b) return [];
    return [...b[1].matchAll(new RegExp(`<signet:${child}>([\\s\\S]*?)</signet:${child}>`, 'g'))].map(m => xu(m[1]));
  };
  const rootAt = a => { const m = new RegExp(`<signet:label\\b[^>]*\\b${a}="([^"]*)"`).exec(xml); return m ? xu(m[1]) : ''; };
  const opRaw = at('lineage', 'op');
  const sigM = /<signet:signature\b[^>]*>([\s\S]*?)<\/signet:signature>/.exec(xml);
  return {
    schema: rootAt('schema'), id: rootAt('id'), grade: txt('grade'),
    basis: { law: at('basis', 'law'), article: at('basis', 'article'), clause: at('basis', 'clause'), registryId: at('basis', 'registryId') },
    issuer: { org: at('issuer', 'org'), unit: at('issuer', 'unit'), keyId: at('issuer', 'keyId') },
    approver: txt('approver'), actionId: txt('actionId'),
    issuedAt: txt('issuedAt'), validUntil: txt('validUntil'),
    revoker: { type: at('revoker', 'type'), ref: at('revoker', 'ref') },
    handling: many('handling', 'code'),
    granularity: txt('granularity'), attach: txt('attach'), trust: txt('trust'),
    releasableTo: { scope: at('releasableTo', 'scope'), orgs: many('releasableTo', 'org'), conditions: many('releasableTo', 'condition') },
    content: { hash: at('content', 'hash'), portions: [] },
    lineage: { parents: many('lineage', 'parent'), op: opRaw === '' || opRaw === 'null' ? null : opRaw },
    releaseId: null, verifyUrl: null,
    signature: { alg: at('signature', 'alg'), over: at('signature', 'over'), value: sigM ? xu(sigM[1]).trim() : '' },
  };
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
// 라벨 XML은 재들여쓰기 없이 그대로 싣는다 — 추출 결과가 부착본과 바이트 동일해야
// 서명 검증 외에 '무결 여부'까지 비교할 수 있다(실측의 라벨 무결 지표).
const wrapXmp = xml => `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="">
${xml.replace(/^<\?xml[^>]*>\s*/, '').replace(/\n$/, '')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
const unwrapXmp = x => {
  const m = /<signet:label[\s\S]*<\/signet:label>/.exec(x);
  return m ? `${XML_DECL}\n${m[0]}\n` : null;
};

/* ── 부착 · 추출 ── */
export function attachLabel(buf, fmt, labelXml) {
  const f = FORMATS[fmt];
  if (f.kind === 'zip') return upsertEntry(buf, f.part, Buffer.from(labelXml, 'utf8'));
  if (f.kind === 'pdf') return attachXmp(buf, wrapXmp(labelXml));
  throw new Error(`${fmt}: 파일 내부 부착 미지원 — --attach sidecar 를 사용하십시오`);
}

export function extractLabelXml(buf, fmt) {
  const f = FORMATS[fmt];
  if (f.kind === 'zip') {
    let entries;
    try { entries = readZip(buf); } catch { return null; }
    const e = entries.find(x => x.name === f.part);
    return e ? entryData(e).toString('utf8') : null;
  }
  if (f.kind === 'pdf') { const x = extractXmp(buf); return x ? unwrapXmp(x) : null; }
  return null;
}

export const sidecarPath = p => p + '.signet.json';
export function readSidecar(p) {
  const s = sidecarPath(p);
  return fs.existsSync(s) ? JSON.parse(fs.readFileSync(s, 'utf8')) : null;
}

/* ── 해시 대상 ──
   whole   : 파일 전체 바이트 (대조군 — 재저장만으로 깨질 것으로 예상)
   payload : 본문 파트만 (ZIP 계열: 정렬된 본문 엔트리의 압축 해제 바이트)
   text    : 본문에서 추출한 텍스트를 공백 정규화 */
export async function computeHash(buf, fmt, target) {
  const f = FORMATS[fmt];
  if (target === 'whole') return sha256Hex(buf);
  // PDF: 라벨은 증분 업데이트로 첫 %%EOF 뒤에 덧붙으므로, 원본 구간(첫 %%EOF까지)이 본문이다.
  // 파일 안에 라벨을 넣으면서 파일 전체를 해시할 수는 없다(자기참조) — 부착 대상을 해시에서 제외한다.
  if (f.kind === 'pdf') {
    if (target !== 'payload') throw new Error(`pdf: '${target}' 해시 대상 미지원 (whole|payload)`);
    const i = buf.indexOf('%%EOF');
    if (i < 0) throw new Error('pdf: %%EOF를 찾을 수 없음');
    return sha256Hex(buf.slice(0, i + 5));
  }
  if (f.kind !== 'zip') throw new Error(`${fmt}: '${target}' 해시 대상 미지원 (payload/text는 ZIP 계열만)`);
  const entries = readZip(buf).filter(e => e.name !== f.part);
  const picked = (f.payload ? entries.filter(e => f.payload.test(e.name)) : entries)
    .sort((a, b) => a.name < b.name ? -1 : 1);
  if (!picked.length) throw new Error(`${fmt}: 본문 파트를 찾지 못함`);
  const parts = picked.map(e => entryData(e));
  if (target === 'payload') {
    // 파트 경계를 해시에 포함해 이어붙이기 모호성을 없앤다
    const joined = Buffer.concat(picked.flatMap((e, i) =>
      [Buffer.from(`\n--${e.name}--\n`, 'utf8'), parts[i]]));
    return sha256Hex(joined);
  }
  if (target === 'text') {
    if (!f.text) throw new Error(`${fmt}: text 해시 대상 미지원`);
    const t = parts.map(p => p.toString('utf8'))
      .join('\n')
      .replace(/<[^>]+>/g, ' ')       // 태그 제거
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ').trim();   // 공백 정규화
    return sha256Hex(Buffer.from(t, 'utf8'));
  }
  throw new Error(`알 수 없는 해시 대상: ${target}`);
}

export const packedHash = (target, hex) => packHash(target, hex);
