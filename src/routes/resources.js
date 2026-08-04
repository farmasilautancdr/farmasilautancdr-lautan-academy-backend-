import { Router } from 'express';
import { google } from 'googleapis';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';

export const resourcesRouter = Router();

// Company-wide, not outlet-scoped — matches GAS (every scope gets the same
// referenceDocs). Category names match GAS's categorizeFolderName exactly;
// anything else (including files dropped loose in the parent folder) falls
// into the same "Halal Certificate" catch-all GAS uses.
const CATEGORY_NAMES = {
  '101 guide to retailing': '101 Guide to Retailing',
  'housebrand modules': 'Housebrand Modules',
  'general policies': 'General Policies',
  'warehousing handbook': 'Warehousing Handbook',
  'elearning courses': 'eLearning Courses',
  'halal certificate': 'Halal Certificate',
};
function categorizeFolderName(name) {
  return CATEGORY_NAMES[(name || '').trim().toLowerCase()] || 'Halal Certificate';
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

function fileToRefDoc(file, category, subcategory) {
  const mime = file.mimeType;
  let kind = 'File', downloadUrl = `https://drive.google.com/uc?export=download&id=${file.id}`;
  if (mime === 'application/vnd.google-apps.document') { kind = 'Doc'; downloadUrl = `https://docs.google.com/document/d/${file.id}/export?format=pdf`; }
  else if (mime === 'application/vnd.google-apps.presentation') { kind = 'Slides'; downloadUrl = `https://docs.google.com/presentation/d/${file.id}/export/pdf`; }
  else if (mime === 'application/vnd.google-apps.spreadsheet') { kind = 'Sheet'; downloadUrl = `https://docs.google.com/spreadsheets/d/${file.id}/export?format=pdf`; }
  else if (mime === 'application/pdf') { kind = 'PDF'; }
  return {
    ID: file.id, Name: file.name, Kind: kind, Category: category, Subcategory: subcategory || '',
    PreviewURL: `https://drive.google.com/file/d/${file.id}/preview`,
    DownloadURL: downloadUrl, Updated: file.modifiedTime,
  };
}

// Best-effort, matches GAS's own try/catch around setSharing — the service
// account only has Viewer access on the shared folder, which often isn't
// enough to grant sharing permissions on files inside it (that requires
// the owner, or "viewers can share" enabled). If this fails, the file is
// still listed; whoever owns the Drive folder needs to share it
// "Anyone with the link" directly for previews/downloads to work for staff.
async function trySetPublicLink(drive, fileId, stats) {
  try {
    await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
  } catch (e) { stats.shareErrors++; }
}

async function listChildren(drive, folderId) {
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime)',
    pageSize: 1000,
  });
  return res.data.files || [];
}

// Recursively walks a folder and everything nested inside it, tagging every
// file found with the top-level category (matches GAS's
// collectFilesRecursive) plus one extra level: the name of the immediate
// subfolder under the category root, if any. A file at
// "Housebrand Modules/Allife/2026/x.pdf" gets Subcategory "Allife" — the
// first folder name below the category root — not "2026"; once subcategory
// is set it's inherited going deeper rather than overwritten, so depth
// beyond that first level doesn't fragment the grouping further. Each
// file/folder failure is caught individually so one bad item can't wipe out
// everything else already found.
async function walkFolder(drive, folderId, category, subcategory, docs, stats) {
  stats.foldersVisited++;
  let children;
  try {
    children = await listChildren(drive, folderId);
  } catch (e) {
    stats.folderErrors++;
    return;
  }
  for (const f of children) {
    if (f.mimeType === FOLDER_MIME) continue;
    try {
      await trySetPublicLink(drive, f.id, stats);
      docs.push(fileToRefDoc(f, category, subcategory));
      stats.filesFound++;
    } catch (e) { stats.fileErrors++; }
  }
  for (const f of children) {
    if (f.mimeType === FOLDER_MIME) {
      await walkFolder(drive, f.id, category, subcategory || f.name, docs, stats);
    }
  }
}

function getDriveClient() {
  if (!env.googleServiceAccountJson) return null;
  const credentials = JSON.parse(env.googleServiceAccountJson);
  const auth = new google.auth.GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/drive'] });
  return google.drive({ version: 'v3', auth });
}

async function getReferenceDocs() {
  const drive = getDriveClient();
  const stats = { foldersVisited: 1, filesFound: 0, fileErrors: 0, folderErrors: 0, shareErrors: 0 };
  if (!drive || !env.referenceFolderId) return { docs: [], stats };

  const docs = [];
  let items;
  try {
    items = await listChildren(drive, env.referenceFolderId);
  } catch (e) {
    stats.folderErrors++;
    return { docs, stats };
  }

  // Files dropped loose in the parent folder go to the catch-all bucket.
  const looseFiles = items.filter(f => f.mimeType !== FOLDER_MIME);
  for (const f of looseFiles) {
    try {
      await trySetPublicLink(drive, f.id, stats);
      docs.push(fileToRefDoc(f, 'Halal Certificate', ''));
      stats.filesFound++;
    } catch (e) { stats.fileErrors++; }
  }

  // Each named subfolder → its matching section, walked recursively.
  // subcategory starts empty — the first folder level found inside sets it.
  const subfolders = items.filter(f => f.mimeType === FOLDER_MIME);
  for (const sub of subfolders) {
    await walkFolder(drive, sub.id, categorizeFolderName(sub.name), '', docs, stats);
  }

  return { docs, stats };
}

// 5-minute cache, matching GAS's RESOURCES_CACHE_SECONDS — the Drive walk is
// the slowest thing this backend does, and results are the same for every
// staff/manager (company-wide, not scoped).
let cache = null, cacheAt = 0;
const CACHE_MS = 5 * 60 * 1000;

resourcesRouter.get('/', requireAuth, async (req, res) => {
  if (cache && Date.now() - cacheAt < CACHE_MS) {
    return res.json({ referenceDocs: cache.docs, resourceSyncStats: cache.stats });
  }
  const result = await getReferenceDocs();
  cache = result;
  cacheAt = Date.now();
  res.json({ referenceDocs: result.docs, resourceSyncStats: result.stats });
});
