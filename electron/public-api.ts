import type { ApiRequest } from "./types.js";
import { withMp4ExtensionHint } from "./watermark.js";

export function toPublicApiRequest(request: ApiRequest) {
  return {
    requestId: request.requestId,
    status: request.status,
    message: request.message,
    model: request.model,
    referenceImageCount: request.referenceImagePaths.length,
    creditCost: request.creditCost,
    creditRefunded: request.creditRefunded,
    cleanVideoUrl: request.cleanVideoUrl ? withMp4ExtensionHint(request.cleanVideoUrl) : null,
    videoUrl: request.cleanVideoUrl ? `/api/requests/${encodeURIComponent(request.requestId)}/video.mp4` : null,
    outputVideoPath: request.outputVideoPath,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    finishedAt: request.finishedAt
  };
}
