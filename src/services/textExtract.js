// Extracts plain text from binary Office/PDF files so their content can be
// used as AI quiz grounding material (see routes/quiz.js sourceType
// 'resource'). Docx/pptx/xlsx are just zip archives of XML — extracted by
// hand with jszip + a regex over the known text-run tags, rather than
// pulling in one dependency per format (mammoth, xlsx/SheetJS, a pptx
// parser). Only two real dependencies needed this way: jszip (all three
// OOXML formats share one zip container) and pdf-parse (PDF isn't
// zip-based, genuinely needs a real parser).
//
// Legacy binary formats (.doc/.ppt/.xls, pre-2007 OLE format) and images
// are NOT supported — those aren't zip+XML and would need a real binary
// parser or OCR respectively. Unsupported input returns '' rather than
// throwing, matching resources.js's existing per-file error tolerance.
import JSZip from 'jszip';
// pdf-parse@1.1.1's own index.js has a bug: it mistakes ESM `import` for
// being run standalone (module.parent is undefined under ESM interop) and
// crashes trying to self-test against a fixture file the npm package
// doesn't ship. Importing the inner lib directly skips that broken wrapper
// — same underlying implementation, no debug self-test.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTagText(xml, tagRegex) {
  const matches = xml.match(tagRegex) || [];
  return unescapeXml(matches.map(m => m.replace(/<[^>]+>/g, '')).join(' '));
}

async function extractDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return '';
  // <w:t>...</w:t> is the text-run element for every visible word in a docx.
  return extractTagText(xml, /<w:t[^>]*>[^<]*<\/w:t>/g);
}

async function extractPptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const perSlide = [];
  for (const name of slideFiles) {
    const xml = await zip.file(name).async('string');
    // <a:t>...</a:t> is DrawingML's text-run element, same idea as w:t for slides.
    perSlide.push(extractTagText(xml, /<a:t[^>]*>[^<]*<\/a:t>/g));
  }
  return perSlide.join('\n\n');
}

async function extractXlsx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('xl/sharedStrings.xml')?.async('string');
  if (!xml) return '';
  // Shared string table covers every text cell in the whole workbook — good
  // enough for grounding text; doesn't preserve row/column layout.
  return extractTagText(xml, /<t[^>]*>[^<]*<\/t>/g);
}

async function extractPdf(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

const EXTRACTORS = {
  'application/pdf': extractPdf,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': extractDocx,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': extractPptx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': extractXlsx,
};

export async function extractText(buffer, mimeType) {
  const fn = EXTRACTORS[mimeType];
  if (!fn) return '';
  try {
    return await fn(buffer);
  } catch (e) {
    return '';
  }
}
