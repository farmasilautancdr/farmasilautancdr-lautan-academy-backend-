// Shared Google Drive access: the client factory (moved here from
// resources.js so quiz.js can reuse it) plus getDriveFileText, which
// resolves a Drive file id to plain text for AI quiz grounding — native
// Google Docs/Slides/Sheets via Drive's own export, everything else via
// download + textExtract.js.
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { extractText } from './textExtract.js';

export function getDriveClient() {
  if (!env.googleServiceAccountJson) return null;
  const credentials = JSON.parse(env.googleServiceAccountJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

// Sheets has no text/plain export — csv is the closest (first sheet only,
// loses formulas/multi-sheet structure, still real cell text for grounding).
const GOOGLE_NATIVE_EXPORT_MIME = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
};

// Returns '' (never throws) on any failure — same tolerance resources.js
// already applies per-file, since one unreadable/unsupported file
// shouldn't break quiz creation, just fall back to the generic-knowledge
// prompt (see quiz.js).
export async function getDriveFileText(fileId) {
  const drive = getDriveClient();
  if (!drive || !fileId) return '';
  try {
    const { data: meta } = await drive.files.get({ fileId, fields: 'mimeType, name' });
    const exportMime = GOOGLE_NATIVE_EXPORT_MIME[meta.mimeType];
    if (exportMime) {
      const res = await drive.files.export({ fileId, mimeType: exportMime }, { responseType: 'text' });
      return (res.data || '').toString();
    }
    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    const buffer = Buffer.from(res.data);
    return await extractText(buffer, meta.mimeType);
  } catch (e) {
    return '';
  }
}
