// PDF XMP 부착 — 증분 업데이트(incremental update)로 Metadata 객체와 Catalog를 덧붙인다.
// 고전 xref 테이블만 지원한다. xref 스트림(PDF 1.5+ 압축 xref)은 명시적으로 거부한다.

function balancedDict(s, from) {
  const start = s.indexOf('<<', from);
  if (start < 0) return null;
  let depth = 0, i = start;
  while (i < s.length - 1) {
    if (s[i] === '<' && s[i + 1] === '<') { depth++; i += 2; continue; }
    if (s[i] === '>' && s[i + 1] === '>') { depth--; i += 2; if (depth === 0) return { start, end: i, text: s.slice(start, i) }; continue; }
    i++;
  }
  return null;
}

function lastTrailerInfo(s) {
  const sx = s.lastIndexOf('startxref');
  if (sx < 0) throw new Error('startxref 없음 — PDF가 아니거나 손상');
  const prev = parseInt(s.slice(sx + 9).trim(), 10);
  const tIdx = s.lastIndexOf('trailer');
  if (tIdx < 0) throw new Error('고전 trailer 없음 (xref 스트림 PDF로 보임) — 이 도구의 측정 대상 외');
  const d = balancedDict(s, tIdx);
  if (!d) throw new Error('trailer 사전 파싱 실패');
  const root = /\/Root\s+(\d+)\s+(\d+)\s+R/.exec(d.text);
  const size = /\/Size\s+(\d+)/.exec(d.text);
  if (!root || !size) throw new Error('trailer에 /Root 또는 /Size 없음');
  return { prevStartXref: prev, rootId: +root[1], size: +size[1] };
}

export function attachXmp(buf, xmp) {
  const s = buf.toString('latin1');
  const { prevStartXref, rootId, size } = lastTrailerInfo(s);
  const objRe = new RegExp(`(^|[^0-9])${rootId}\\s+0\\s+obj`, 'g');
  let m, catIdx = -1;
  while ((m = objRe.exec(s))) catIdx = m.index + m[0].length;   // 증분본이 있으면 마지막 정의를 취한다
  if (catIdx < 0) throw new Error(`Catalog 객체 ${rootId} 0 obj 를 찾을 수 없음`);
  const dict = balancedDict(s, catIdx);
  if (!dict) throw new Error('Catalog 사전 파싱 실패');

  const metaId = size;
  let inner = dict.text.slice(2, -2).replace(/\/Metadata\s+\d+\s+\d+\s+R/g, '').trim();
  const catNew = `<< ${inner} /Metadata ${metaId} 0 R >>`;

  let out = Buffer.from(buf);
  if (out[out.length - 1] !== 0x0a) out = Buffer.concat([out, Buffer.from('\n', 'latin1')]);

  const xmpBuf = Buffer.from(xmp, 'utf8');
  const metaObj = Buffer.concat([
    Buffer.from(`${metaId} 0 obj\n<< /Type /Metadata /Subtype /XML /Length ${xmpBuf.length} >>\nstream\n`, 'latin1'),
    xmpBuf, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
  const catObj = Buffer.from(`${rootId} 0 obj\n${catNew}\nendobj\n`, 'latin1');

  const metaOff = out.length;
  const catOff = metaOff + metaObj.length;
  const xrefOff = catOff + catObj.length;

  const ids = [rootId, metaId].sort((a, b) => a - b);
  const offs = { [rootId]: catOff, [metaId]: metaOff };
  let xref = 'xref\n';
  let i = 0;
  while (i < ids.length) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j] + 1) j++;
    xref += `${ids[i]} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${String(offs[ids[k]]).padStart(10, '0')} 00000 n \n`;
    i = j + 1;
  }
  const trailer = `trailer\n<< /Size ${metaId + 1} /Root ${rootId} 0 R /Prev ${prevStartXref} >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return Buffer.concat([out, metaObj, catObj, Buffer.from(xref + trailer, 'latin1')]);
}

export function extractXmp(buf) {
  const s = buf.toString('latin1');
  // 가장 마지막에 정의된 Metadata 스트림을 취한다
  const re = /\/Type\s*\/Metadata[\s\S]{0,200}?stream\r?\n/g;
  let m, last = -1, hdrEnd = -1;
  while ((m = re.exec(s))) { last = m.index; hdrEnd = m.index + m[0].length; }
  if (last < 0) return null;
  const end = s.indexOf('endstream', hdrEnd);
  if (end < 0) return null;
  return Buffer.from(s.slice(hdrEnd, end), 'latin1').toString('utf8').replace(/\s+$/, '');
}

// 측정 시료용 최소 PDF (고전 xref)
export function makeMinimalPdf(lines) {
  const content = lines.map((t, i) =>
    `BT /F1 11 Tf 60 ${760 - i * 18} Td (${t.replace(/([()\\])/g, '\\$1')}) Tj ET`).join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(out.length);
    if (i === 3) out += `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`;
    else out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOff = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
