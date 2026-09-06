#!/usr/bin/env node
// Signet CLI — 실파일 라벨 부착·검증 및 편집기 보존성 실측 도구.
// 사용법: node signet.mjs <명령> [옵션]
import fs from 'node:fs';
import path from 'node:path';
import {
  generateOrgKey, issueCert, verifyCert, buildLabel, verifyLabelSignature,
  canonicalizeLabel, unpackHash, sha256Hex,
} from './lib/label.mjs';
import {
  FORMATS, detectFormat, capabilities, labelToXml, xmlToLabel,
  attachLabel, extractLabelXml, computeHash, sidecarPath, readSidecar,
} from './lib/formats.mjs';
import { makeMinimalPdf } from './lib/pdf.mjs';
import { writeZip } from './lib/zipfile.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = name => argv.includes('--' + name);
const positional = argv.slice(1).filter(a => !a.startsWith('--') &&
  !(argv[argv.indexOf(a) - 1] || '').startsWith('--'));

const C = { ok: s => `\x1b[32m${s}\x1b[0m`, bad: s => `\x1b[31m${s}\x1b[0m`,
  warn: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[90m${s}\x1b[0m`, b: s => `\x1b[1m${s}\x1b[0m` };

const KEYDIR = () => opt('keys', 'work/keys');
const loadKeys = () => {
  const d = KEYDIR();
  if (!fs.existsSync(path.join(d, 'root.json'))) throw new Error(`키가 없습니다 — 먼저 'keygen'을 실행하십시오 (${d})`);
  return {
    root: JSON.parse(fs.readFileSync(path.join(d, 'root.json'), 'utf8')),
    org: JSON.parse(fs.readFileSync(path.join(d, 'org.json'), 'utf8')),
    cert: JSON.parse(fs.readFileSync(path.join(d, 'cert.json'), 'utf8')),
  };
};

/* ── keygen ── */
async function cmdKeygen() {
  const dir = KEYDIR();
  fs.mkdirSync(dir, { recursive: true });
  const root = await generateOrgKey('root', '인증관리과');
  const org = await generateOrgKey(opt('org', 'kpost'), opt('unit', '정보보안팀'));
  const cert = await issueCert(root, org);
  fs.writeFileSync(path.join(dir, 'root.json'), JSON.stringify(root, null, 2));
  fs.writeFileSync(path.join(dir, 'org.json'), JSON.stringify(org, null, 2));
  fs.writeFileSync(path.join(dir, 'cert.json'), JSON.stringify(cert, null, 2));
  console.log(C.ok('✓') + ` 키·인증서 생성: ${dir}`);
  console.log(C.dim(`  root → ${org.org} 체인 검증: ${await verifyCert(root, cert)}`));
  console.log(C.warn('  ※ 개인키가 평문 JSON입니다. 실측용이며 운영에서는 HSM/KMS를 씁니다.'));
}

/* ── attach ── */
async function cmdAttach() {
  const file = positional[0];
  if (!file) throw new Error('대상 파일을 지정하십시오');
  const fmt = detectFormat(file);
  if (!fmt) throw new Error(`지원하지 않는 확장자: ${file}`);
  const { root, org, cert } = loadKeys();
  const cap = capabilities(fmt);
  const mode = opt('attach', cap.embed ? 'embedded' : 'sidecar');
  if (mode === 'embedded' && !cap.embed)
    throw new Error(`${fmt}는 파일 내부 부착 미지원입니다 — --attach sidecar 사용 (${cap.note})`);

  const buf = fs.readFileSync(file);
  let target = opt('hash-target', cap.payload ? 'payload' : 'whole');
  const hex = await computeHash(buf, fmt, target);

  const label = await buildLabel({
    key: org, grade: opt('grade', 'S'), basisId: opt('basis', 'AUDIT'),
    approver: opt('approver', '오주상 계장'),
    handling: (opt('handling', '') || '').split(',').filter(Boolean),
    scope: opt('scope', 'internal'),
    orgs: (opt('orgs', '') || '').split(',').filter(Boolean),
    attach: mode, hashTarget: target, hashHex: hex,
  });
  const xml = labelToXml(label);
  const out = opt('out', file);

  if (mode === 'sidecar') {
    fs.writeFileSync(sidecarPath(out), JSON.stringify({ file: path.basename(file), label }, null, 2));
    if (out !== file) fs.writeFileSync(out, buf);
    console.log(C.ok('✓') + ` 사이드카 부착: ${sidecarPath(out)}`);
  } else {
    fs.writeFileSync(out, attachLabel(buf, fmt, xml));
    console.log(C.ok('✓') + ` 부착: ${out}  (${FORMATS[fmt].part})`);
  }
  console.log(`  등급 ${label.grade} · 근거 ${label.basis.registryId} · 해시대상 ${C.b(target)} · ${label.content.hash.slice(0, 30)}…`);
}

/* ── extract ── */
async function cmdExtract() {
  const file = positional[0];
  const fmt = detectFormat(file);
  const buf = fs.readFileSync(file);
  const xml = extractLabelXml(buf, fmt);
  if (xml) { process.stdout.write(xml.endsWith('\n') ? xml : xml + '\n'); return; }
  const side = readSidecar(file);
  if (side) { console.log(JSON.stringify(side, null, 2)); return; }
  console.error(C.bad('✗') + ' 라벨을 찾을 수 없습니다 (임베디드·사이드카 모두 없음)');
  process.exitCode = 2;
}

/* ── verify ── */
async function verifyFile(file, quiet) {
  const fmt = detectFormat(file);
  const buf = fs.readFileSync(file);
  const { root, cert } = loadKeys();
  const say = (...a) => { if (!quiet) console.log(...a); };

  let label = null, via = null;
  const xml = extractLabelXml(buf, fmt);
  if (xml) { label = xmlToLabel(xml); via = 'embedded'; }
  else { const s = readSidecar(file); if (s) { label = s.label; via = 'sidecar'; } }
  if (!label) { say(C.bad('✗ 라벨 없음') + ' — 미분류(U) 취급'); return { ok: false, reason: 'no-label' }; }

  const chainOk = await verifyCert(root, cert);
  const sigOk = await verifyLabelSignature(label, cert);
  const { target, hex } = unpackHash(label.content.hash);
  let curHex = null, hashOk = false, hashErr = null;
  try { curHex = await computeHash(buf, fmt, target); hashOk = curHex === hex; }
  catch (e) { hashErr = e.message; }
  const expired = label.validUntil && new Date(label.validUntil) < new Date();

  say(`${C.b(path.basename(file))}  ${C.dim(`(${fmt} · ${via})`)}`);
  say(`  체인      ${chainOk ? C.ok('✓') : C.bad('✗')}  ${label.issuer.org} ← root`);
  say(`  서명      ${sigOk ? C.ok('✓') : C.bad('✗')}  ${label.signature.alg} over ${label.signature.over}`);
  say(`  해시      ${hashOk ? C.ok('✓') : C.bad('✗')}  대상=${target} ${hashErr ? C.warn('(' + hashErr + ')') : ''}`);
  if (!hashOk && !hashErr) say(C.dim(`            발급 ${hex.slice(0, 16)}… / 현재 ${String(curHex).slice(0, 16)}…`));
  say(`  수명      ${expired ? C.bad('✗ 만료') : C.ok('✓')}  ${label.validUntil ? label.validUntil.slice(0, 10) : '무기한'}`);
  const ok = chainOk && sigOk && hashOk && !expired;
  say(`  ${ok ? C.ok('▶ 유효 (VALID)') : C.bad('▶ 무효 (INVALID)')}  등급 ${label.grade} · ${label.basis.registryId}`);
  return { ok, via, chainOk, sigOk, hashOk, expired, target, label };
}
async function cmdVerify() {
  const r = await verifyFile(positional[0]);
  process.exitCode = r.ok ? 0 : 1;
}

/* ── hash ── */
async function cmdHash() {
  const file = positional[0];
  const fmt = detectFormat(file);
  const buf = fs.readFileSync(file);
  for (const t of ['whole', 'payload', 'text']) {
    try { console.log(`${t.padEnd(8)} ${await computeHash(buf, fmt, t)}`); }
    catch (e) { console.log(`${t.padEnd(8)} ${C.dim('— ' + e.message)}`); }
  }
}

/* ── specimen: 실측 시료 일괄 생성 ── */
async function cmdSpecimen() {
  const dir = opt('out', 'work/specimen');
  fs.mkdirSync(dir, { recursive: true });
  const body = [
    '2026년 주요 사업계획(초안) — 내부 검토용',
    '1. 우체국 금융 차세대 시스템 2단계 착수',
    '2. 물류센터 자동화 시범국 선정',
    '※ 본 문서는 내부 검토 중인 초안입니다.',
  ];
  const made = [];

  // HWPX (OWPML 최소 골격)
  made.push(['hwpx', path.join(dir, 'S-01_사업계획_초안.hwpx'), writeZip([
    { name: 'mimetype', data: Buffer.from('application/hwp+zip'), store: true },
    { name: 'version.xml', data: Buffer.from('<?xml version="1.0"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR"/>') },
    { name: 'Contents/content.hpf', data: Buffer.from('<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"/>') },
    { name: 'Contents/section0.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section">\n${body.map(t => `  <hp:p><hp:run><hp:t>${t}</hp:t></hp:run></hp:p>`).join('\n')}\n</hs:sec>`) },
    { name: 'META-INF/manifest.xml', data: Buffer.from('<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>') },
    { name: 'docProps/core.xml', data: Buffer.from('<?xml version="1.0"?><cp:coreProperties><dc:creator>박정운</dc:creator><cp:lastModifiedBy>박정운</cp:lastModifiedBy></cp:coreProperties>') },
  ])]);

  // DOCX (OOXML 최소 골격)
  made.push(['docx', path.join(dir, 'S-02_사업계획_초안.docx'), writeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>') },
    { name: 'word/document.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>\n${body.map(t => `  <w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('\n')}\n</w:body></w:document>`) },
    { name: 'docProps/core.xml', data: Buffer.from('<?xml version="1.0"?><cp:coreProperties><dc:creator>박정운</dc:creator></cp:coreProperties>') },
  ])]);

  // PDF
  made.push(['pdf', path.join(dir, 'S-03_통계요약.pdf'), makeMinimalPdf(['Signet specimen', ...body.map((_, i) => `line ${i + 1}`)])]);

  // HWP (CFB 미구현 — 사이드카 측정용 더미 바이트)
  made.push(['hwp', path.join(dir, 'S-04_보도자료.hwp'),
    Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from(body.join('\n'), 'utf8')])]);

  for (const [fmt, p, buf] of made) fs.writeFileSync(p, buf);
  console.log(C.ok('✓') + ` 시료 ${made.length}건 생성: ${dir}`);
  for (const [fmt, p] of made) {
    const cap = capabilities(fmt);
    console.log(`  ${path.basename(p).padEnd(30)} ${fmt.padEnd(5)} 부착 ${cap.embed ? C.ok('embedded') : C.warn('sidecar만')}`);
  }
  console.log(C.dim('\n  다음: node signet.mjs attach <파일> --grade S --basis AUDIT'));
}

/* ── roundtrip: 재저장 전후 비교 ── */
async function cmdRoundtrip() {
  const before = opt('before'), after = opt('after');
  if (!before || !after) throw new Error('--before <원본> --after <재저장본> 을 지정하십시오');
  const fmt = detectFormat(before);
  const b = fs.readFileSync(before), a = fs.readFileSync(after);
  const { root, cert } = loadKeys();

  const bx = extractLabelXml(b, fmt), ax = extractLabelXml(a, fmt);
  const survived = !!ax;
  const identical = survived && bx === ax;
  const label = bx ? xmlToLabel(bx) : (readSidecar(before) || {}).label;
  const { target, hex } = label ? unpackHash(label.content.hash) : { target: 'whole', hex: '' };

  const hashes = {};
  for (const t of ['whole', 'payload', 'text']) {
    try { hashes[t] = { before: await computeHash(b, fmt, t), after: await computeHash(a, fmt, t) }; }
    catch (e) { hashes[t] = { err: e.message }; }
  }
  let sigOk = null;
  if (ax) { try { sigOk = await verifyLabelSignature(xmlToLabel(ax), cert); } catch { sigOk = false; } }

  console.log(C.b(`재저장 보존성 — ${path.basename(before)} → ${path.basename(after)}`));
  console.log(`  파일 크기      ${b.length} B → ${a.length} B`);
  console.log(`  라벨 생존      ${survived ? C.ok('○ 살아남음') : C.bad('× 유실')}`);
  if (survived) console.log(`  라벨 무결      ${identical ? C.ok('○ 바이트 동일') : C.warn('△ 내용 변형')}   서명 재검증 ${sigOk ? C.ok('✓') : C.bad('✗')}`);
  console.log(`  ${C.b('해시 대상별 안정성')}  ${C.dim('(발급 시 사용한 대상: ' + target + ')')}`);
  for (const t of ['whole', 'payload', 'text']) {
    const h = hashes[t];
    if (h.err) { console.log(`    ${t.padEnd(8)} ${C.dim('— ' + h.err)}`); continue; }
    const same = h.before === h.after;
    console.log(`    ${t.padEnd(8)} ${same ? C.ok('○ 안정') : C.bad('× 변경')}  ${h.before.slice(0, 12)}… → ${h.after.slice(0, 12)}…`);
  }
  const verdict = survived && (hashes[target] && !hashes[target].err && hashes[target].before === hashes[target].after);
  console.log(`  ${verdict ? C.ok('▶ 라운드트립 통과') : C.bad('▶ 라운드트립 실패')}`);
  process.exitCode = verdict ? 0 : 1;
}

/* ── help ── */
function help() {
  console.log(`${C.b('Signet CLI')} — 실파일 라벨 부착·검증 및 편집기 보존성 실측

  ${C.b('keygen')}    [--keys DIR] [--org ID] [--unit NAME]      기관 키쌍·간이 인증서 생성
  ${C.b('specimen')}  [--out DIR]                                 실측 시료 일괄 생성 (hwpx/docx/pdf/hwp)
  ${C.b('attach')}    <파일> [--grade S] [--basis AUDIT] [--approver 이름]
                      [--attach embedded|sidecar] [--hash-target whole|payload|text]
                      [--scope internal|federated|unrestricted] [--out 경로]
  ${C.b('extract')}   <파일>                                      부착된 라벨 원본 출력
  ${C.b('verify')}    <파일>                                      체인·서명·해시·수명 검증 (종료코드 0/1)
  ${C.b('hash')}      <파일>                                      해시 대상별 값 비교 출력
  ${C.b('roundtrip')} --before 원본 --after 재저장본               편집기 재저장 보존성 판정
  ${C.b('caps')}                                                  포맷별 부착·해시 능력 매트릭스

${C.dim('실측 절차는 ../Signet_부착보존성_실측계획서.md 를 따르십시오.')}`);
}

function cmdCaps() {
  console.log(C.b('포맷별 능력'));
  for (const f of Object.keys(FORMATS)) {
    const c = capabilities(f);
    console.log(`  ${f.padEnd(5)} 부착 ${c.embed ? C.ok('○') : C.bad('×')}  payload ${c.payload ? C.ok('○') : C.dim('×')}  text ${c.text ? C.ok('○') : C.dim('×')}  ${C.dim(FORMATS[f].part)} ${c.note ? C.warn(c.note) : ''}`);
  }
}

const CMDS = { keygen: cmdKeygen, attach: cmdAttach, extract: cmdExtract, verify: cmdVerify,
  hash: cmdHash, specimen: cmdSpecimen, roundtrip: cmdRoundtrip, caps: cmdCaps };

(async () => {
  if (!cmd || cmd === 'help' || cmd === '--help') return help();
  const fn = CMDS[cmd];
  if (!fn) { console.error(C.bad(`알 수 없는 명령: ${cmd}`)); help(); process.exitCode = 2; return; }
  try { await fn(); }
  catch (e) { console.error(C.bad('✗ ') + e.message); process.exitCode = 2; }
})();
