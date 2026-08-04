import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env`);
  return v;
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET'),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
  port: parseInt(process.env.PORT) || 3000,
  // Optional — only the /content/upload route needs these. Not required()
  // so the rest of the app still boots without them.
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  // Optional — only /resources needs these. Not required() so the rest of
  // the app still boots without them.
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  referenceFolderId: process.env.REFERENCE_FOLDER_ID || '',
};
