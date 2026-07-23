import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import type { Readable } from "stream";

// Cloudflare R2 speaks the S3 API, so the regular AWS S3 SDK works against
// it -- just point `endpoint` at R2's account-scoped URL instead of AWS.
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const BUCKET_NAME = process.env.R2_BUCKET_NAME;
// Public base URL for the bucket (R2.dev subdomain or a connected custom
// domain), no trailing slash -- e.g. https://pub-xxxxxxxx.r2.dev
const PUBLIC_URL = process.env.R2_PUBLIC_URL?.replace(/\/$/, "");

export const storageEnabled = Boolean(
  ACCOUNT_ID && ACCESS_KEY_ID && SECRET_ACCESS_KEY && BUCKET_NAME && PUBLIC_URL
);

const client = storageEnabled
  ? new S3Client({
      region: "auto",
      endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: ACCESS_KEY_ID!, secretAccessKey: SECRET_ACCESS_KEY! },
    })
  : null;

export interface RecordingUploadTarget {
  uploadUrl: string;
  publicUrl: string;
}

// Only URLs under our own bucket's public base may ever be persisted as a
// meeting's recording_url. Without this check, anyone who learned a
// meeting's id could store an arbitrary URL there -- which the history page
// then renders as a <video src> and a download link for the owner.
export function isOwnRecordingUrl(url: string): boolean {
  return Boolean(PUBLIC_URL) && url.startsWith(`${PUBLIC_URL}/recordings/`);
}

export async function createRecordingUploadUrl(
  meetingId: string,
  contentType: string
): Promise<RecordingUploadTarget | null> {
  if (!client) return null;

  const extension = contentType.includes("mp4") ? "mp4" : "webm";
  const key = `recordings/${meetingId}/${randomUUID()}.${extension}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 10 * 60 });
  return { uploadUrl, publicUrl: `${PUBLIC_URL}/${key}` };
}

// Server-side fallback: when the browser's direct-to-R2 PUT fails (most often
// because the bucket's CORS isn't set up to allow PUT from the app origin), the
// client re-sends the video through our server instead. The server has R2
// credentials and talks to R2 server-to-server, so no browser CORS applies and
// the recording still reaches the bucket + history. Streamed via multipart in
// 5 MB parts so the whole video is never buffered in memory at once (keeps the
// small free-tier instance from OOMing on a long recording).
export async function uploadRecordingStream(
  meetingId: string,
  contentType: string,
  body: Readable
): Promise<string | null> {
  if (!client || !BUCKET_NAME || !PUBLIC_URL) return null;
  const extension = contentType.includes("mp4") ? "mp4" : "webm";
  const key = `recordings/${meetingId}/${randomUUID()}.${extension}`;
  const upload = new Upload({
    client,
    params: { Bucket: BUCKET_NAME, Key: key, Body: body, ContentType: contentType },
    partSize: 5 * 1024 * 1024,
    queueSize: 2,
  });
  await upload.done();
  return `${PUBLIC_URL}/${key}`;
}
