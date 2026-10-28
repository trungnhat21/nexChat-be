import { EncodedFileOutput, EncodedFileType, S3Upload } from "livekit-server-sdk";

export interface EgressStorageSettings {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secret: string;
    region: string;
}

export function makeRecordingOutput(objectKey: string, storage: EgressStorageSettings): EncodedFileOutput {
    if (!/^recordings\/[1-9]\d*\/[0-9a-f-]{36}\.mp4$/i.test(objectKey)) throw new Error("Invalid recording object key.");
    return new EncodedFileOutput({
        fileType: EncodedFileType.MP4,
        filepath: objectKey,
        disableManifest: true,
        output: {
            case: "s3",
            value: new S3Upload({
                endpoint: storage.endpoint,
                bucket: storage.bucket,
                accessKey: storage.accessKey,
                secret: storage.secret,
                region: storage.region,
                forcePathStyle: true,
            }),
        },
    });
}
