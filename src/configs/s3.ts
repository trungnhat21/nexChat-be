import "dotenv/config";
import { S3Client } from "@aws-sdk/client-s3";

const {
  S3_ENDPOINT,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  S3_REGION,
} = process.env;

if (!S3_ENDPOINT) {
  throw new Error("Missing S3_ENDPOINT");
}

if (!S3_ACCESS_KEY_ID) {
  throw new Error("Missing S3_ACCESS_KEY_ID");
}

if (!S3_SECRET_ACCESS_KEY) {
  throw new Error("Missing S3_SECRET_ACCESS_KEY");
}

const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION || "us-east-1",
  credentials: {
    accessKeyId: S3_ACCESS_KEY_ID,
    secretAccessKey: S3_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

export default s3;